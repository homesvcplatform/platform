# GitHub OIDC CI build role in the shared-services account (Phase 1 14 §2.1, §2.5; Gate 1 I-2 Option A, ADR-022 #11).
# No long-lived AWS keys. Assumable only from this repository's main branch; can push only to the shared backend
# repository (infra/modules/registry). Deploy roles stay in each workload account (infra/modules/ci-oidc).
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
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

output "ci_build_role_arn" { value = aws_iam_role.ci_build.arn }
