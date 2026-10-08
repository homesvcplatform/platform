# Secret containers (no values in code or state). Values are set out-of-band by an operator or a rotation
# function. Apps receive them via ECS secrets injection (Phase 2 / 02 §4). Placeholders for Gate 3 needs.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
variable "secrets_kms_key_arn" { type = string }
variable "secret_names" {
  type = list(string)
  default = [
    "bff/client-ip-signing-key",   # G-6 / SR-10 signed client-IP header
    "identity/otp-hmac-pepper",    # OTP challenge HMAC
    "identity/blind-index-pepper", # phone blind index
  ]
}

resource "aws_secretsmanager_secret" "this" {
  #checkov:skip=CKV2_AWS_57:Rotation lambdas are introduced with the consuming feature (Gate 3); values are not set in Gate 1.
  for_each                = toset(var.secret_names)
  name                    = "${var.name_prefix}/${each.key}"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 30
}

output "secret_arns" { value = { for k, s in aws_secretsmanager_secret.this : k => s.arn } }
