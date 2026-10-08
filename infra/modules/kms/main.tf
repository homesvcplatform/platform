# Customer-managed KMS keys per data class (Phase 1 14 §2.3, SR-06). Separate keys limit decryption blast radius:
# each process role is later granted only the classes it needs.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" {
  type        = string
  description = "e.g. hsp-dev"
}

variable "data_classes" {
  type        = list(string)
  description = "Symmetric data-class keys to create. The image registry key lives in shared-services (infra/modules/registry, I-2)."
  default = [
    "db", "pii-contact", "pii-address", "kyc", "recordings", "restricted-attributes",
    "files-general", "logs", "backup", "audit", "secrets",
  ]
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

data "aws_iam_policy_document" "key" {
  #checkov:skip=CKV_AWS_109:Root-account key administration statement is the AWS-recommended baseline; role-scoped grants are added per gate.
  #checkov:skip=CKV_AWS_111:Same baseline statement; KMS key policies are resource-scoped to the key itself.
  #checkov:skip=CKV_AWS_356:Key policies always apply to the key they are attached to ("*" means this key).
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
  statement {
    sid       = "CloudWatchLogsUse"
    effect    = "Allow"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${data.aws_region.current.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_kms_key" "data_class" {
  for_each                = toset(var.data_classes)
  description             = "${var.name_prefix} ${each.key} data-class key"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
  tags                    = { data_class = each.key }
}

resource "aws_kms_alias" "data_class" {
  for_each      = aws_kms_key.data_class
  name          = "alias/${var.name_prefix}-${each.key}"
  target_key_id = each.value.key_id
}

# Asymmetric signing key for access tokens (Phase 1 05 §3.1). Asymmetric keys cannot auto-rotate;
# rotation is by issuing a new key and kid overlap (runbook), every 90 days.
resource "aws_kms_key" "jwt_signing" {
  #checkov:skip=CKV_AWS_7:Asymmetric SIGN_VERIFY keys do not support automatic rotation; rotated via new key + kid overlap.
  description              = "${var.name_prefix} access-token signing key (ES256)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.key.json
  tags                     = { data_class = "jwt-signing" }
}

resource "aws_kms_alias" "jwt_signing" {
  name          = "alias/${var.name_prefix}-jwt-signing"
  target_key_id = aws_kms_key.jwt_signing.key_id
}

output "key_arns" {
  value = { for k, v in aws_kms_key.data_class : k => v.arn }
}

output "jwt_signing_key_arn" {
  value = aws_kms_key.jwt_signing.arn
}
