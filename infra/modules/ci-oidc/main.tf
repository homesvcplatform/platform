# GitHub OIDC trust for CI (build/push) and deploy roles - no long-lived AWS keys anywhere (Phase 1 14 §2.5).
# The build role can only push to the backend ECR repository from main. The deploy role can only register
# task definitions / update services in this cluster, only from the matching GitHub environment.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
variable "environment" { type = string }
variable "github_repository" {
  type        = string
  description = "owner/repo, e.g. homesvcplatform/platform"
}
variable "create_oidc_provider" {
  type    = bool
  default = true
}
variable "ecr_repository_arn" { type = string }
variable "ecr_kms_key_arn" { type = string }
variable "cluster_arn" { type = string }
variable "execution_role_arn" { type = string }
variable "task_role_arns" { type = map(string) }

data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  oidc_provider_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "ci_build" {
  name                 = "${var.name_prefix}-ci-build"
  assume_role_policy   = data.aws_iam_policy_document.ci_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ci_build" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken does not support resource-level permissions.
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
      "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages",
    ]
    resources = [var.ecr_repository_arn]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.ecr_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "ci_build" {
  role   = aws_iam_role.ci_build.id
  policy = data.aws_iam_policy_document.ci_build.json
}

data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.environment}"]
    }
  }
}

# Name pattern hsp-<env>-deploy is what the organisation SCP allows to register task definitions (infra/org).
resource "aws_iam_role" "deploy" {
  name                 = "${var.name_prefix}-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "RegisterTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:TagResource"]
    resources = ["*"] # RegisterTaskDefinition does not support resource-level permissions.
  }
  statement {
    sid       = "UpdateServicesInThisClusterOnly"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = ["arn:aws:ecs:ap-south-1:${data.aws_caller_identity.current.account_id}:service/${split("/", var.cluster_arn)[1]}/*"]
  }
  statement {
    sid       = "PassOnlyTaskRolesToEcs"
    actions   = ["iam:PassRole"]
    resources = concat([var.execution_role_arn], values(var.task_role_arns))
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "ReadImagesForVerification"
    actions   = ["ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages"]
    resources = ["*"]
  }
  statement {
    sid       = "DecryptImageLayers"
    actions   = ["kms:Decrypt"]
    resources = [var.ecr_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "ci_build_role_arn" { value = aws_iam_role.ci_build.arn }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
