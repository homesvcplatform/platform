# GitHub OIDC trust for the per-environment deploy role - no long-lived AWS keys anywhere (Phase 1 14 §2.5).
# The deploy role can only register task definitions / update services in this cluster, only from the matching
# GitHub environment. The CI build (push) role lives in the shared-services account (infra/modules/ci-build, I-2).
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
variable "ecr_repository_arn" {
  type        = string
  description = "Shared backend repository (shared-services account). The deploy role reads images and signatures from it only."
}
variable "ecr_kms_key_arn" {
  type        = string
  description = "Shared registry KMS key (shared-services account). The deploy role decrypts image layers for verification."
}
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
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"] # These two actions do not support resource-level permissions.
  }
  statement {
    sid       = "TagOnlyThisEnvironmentsTaskDefinitions"
    actions   = ["ecs:TagResource"]
    resources = ["arn:aws:ecs:ap-south-1:${data.aws_caller_identity.current.account_id}:task-definition/${var.name_prefix}-*:*"]
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
    sid       = "RegistryAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken does not support resource-level permissions.
  }
  statement {
    sid       = "ReadSharedRepositoryForVerification"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages"]
    resources = [var.ecr_repository_arn]
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

output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
