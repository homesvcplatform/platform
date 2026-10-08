# Shared backend image registry in the shared-services account (Phase 1 14 §2.1; Gate 1 I-2 Option A, ADR-022 #11).
# One immutable, KMS-encrypted ECR repository. CI pushes once; dev/test pull the same digest cross-account.
# Only the consumer accounts' task-execution and deploy roles may pull. Only the CI build role may push: an explicit
# Deny covers every other principal, including administrators in this account.
# An empty consumer list (TE-01: dev/test accounts not created yet) means no cross-account access at all.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" {
  type        = string
  description = "e.g. hsp-shared"
}

variable "consumer_account_ids" {
  type        = list(string)
  description = "Workload account ids (dev, test) whose hsp-*-task-execution and hsp-*-deploy roles may pull images. Empty until those accounts exist (TE-01). Never use placeholder ids."
  validation {
    condition     = alltrue([for id in var.consumer_account_ids : can(regex("^[0-9]{12}$", id))])
    error_message = "consumer_account_ids must contain only 12-digit AWS account ids."
  }
}

data "aws_caller_identity" "current" {}

locals {
  has_consumers = length(var.consumer_account_ids) > 0
  # Same name as the role created by infra/modules/ci-build in this account (name_prefix + "-ci-build").
  ci_build_role_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-ci-build"
  # Role-name patterns created by infra/modules/ecs-platform (task execution) and infra/modules/ci-oidc (deploy).
  consumer_role_arn_patterns = flatten([
    for id in var.consumer_account_ids : [
      "arn:aws:iam::${id}:role/hsp-*-task-execution",
      "arn:aws:iam::${id}:role/hsp-*-deploy",
    ]
  ])
}

data "aws_iam_policy_document" "key" {
  #checkov:skip=CKV_AWS_109:Root-account key administration statement is the AWS-recommended baseline.
  #checkov:skip=CKV_AWS_111:Same baseline statement; KMS key policies are resource-scoped to the key itself.
  #checkov:skip=CKV_AWS_356:Key policies always apply to the key they are attached to ("*" means this key).
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  dynamic "statement" {
    for_each = local.has_consumers ? [1] : []
    content {
      sid       = "ConsumerRolesDecryptImageLayers"
      actions   = ["kms:Decrypt"]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = [for id in var.consumer_account_ids : "arn:aws:iam::${id}:root"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = local.consumer_role_arn_patterns
      }
    }
  }
}

resource "aws_kms_key" "ecr" {
  description             = "${var.name_prefix} backend image registry"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
  tags                    = { data_class = "ecr" }
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/${var.name_prefix}-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

resource "aws_ecr_repository" "backend" {
  name                 = "${var.name_prefix}-backend"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire supply-chain self-test images after 1 day"
        selection    = { tagStatus = "tagged", tagPrefixList = ["selftest-unsigned-"], countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 200 images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 200 }
        action       = { type = "expire" }
      },
    ]
  })
}

# Cross-account pull only (read actions), and only when consumer accounts are listed. Push is denied to every principal
# except the CI build role (infra/modules/ci-build). A same-account IAM allow alone would otherwise be enough to push.
data "aws_iam_policy_document" "repository" {
  statement {
    sid    = "OnlyCiBuildRolePushes"
    effect = "Deny"
    actions = [
      "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
    ]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.ci_build_role_arn]
    }
  }
  dynamic "statement" {
    for_each = local.has_consumers ? [1] : []
    content {
      sid = "ConsumerRolesPullImages"
      actions = [
        "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:DescribeImages",
      ]
      principals {
        type        = "AWS"
        identifiers = [for id in var.consumer_account_ids : "arn:aws:iam::${id}:root"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = local.consumer_role_arn_patterns
      }
    }
  }
}

resource "aws_ecr_repository_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy     = data.aws_iam_policy_document.repository.json
}

output "repository_arn" { value = aws_ecr_repository.backend.arn }
output "repository_url" { value = aws_ecr_repository.backend.repository_url }
output "kms_key_arn" { value = aws_kms_key.ecr.arn }
