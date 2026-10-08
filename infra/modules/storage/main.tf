# S3 buckets (Phase 1 10 §1): private only, SSE-KMS per data class, TLS-only, versioned, access-logged.
# No public buckets: per-bucket public access block here + account-level block in the guardrails module.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
variable "kms_key_arns" {
  type        = map(string)
  description = "Data-class key ARNs from the kms module."
}

locals {
  buckets = {
    quarantine    = { key = "files-general", object_lock = false, noncurrent_days = 7 }
    clean         = { key = "files-general", object_lock = false, noncurrent_days = 7 }
    kyc           = { key = "kyc", object_lock = false, noncurrent_days = 7 }
    recordings    = { key = "recordings", object_lock = false, noncurrent_days = 7 }
    documents     = { key = "files-general", object_lock = false, noncurrent_days = 30 }
    audit-archive = { key = "audit", object_lock = true, noncurrent_days = 365 }
  }
}

# ---- access-log bucket -------------------------------------------------------------------------------
resource "aws_s3_bucket" "access_logs" {
  #checkov:skip=CKV_AWS_18:This is the access-log destination; logging it to itself would recurse.
  #checkov:skip=CKV_AWS_144:Cross-region replication is out of scope for dev/test (Phase 1 14 §5 applies to staging/prod-like).
  #checkov:skip=CKV2_AWS_62:Event notifications are not needed for the access-log bucket.
  #checkov:skip=CKV_AWS_145:S3 server access logging only supports SSE-S3 on the destination bucket.
  bucket = "${var.name_prefix}-s3-access-logs"
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 400 }
    noncurrent_version_expiration { noncurrent_days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

# ---- data buckets ------------------------------------------------------------------------------------
resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_144:Cross-region replication is configured for staging/prod-like only (Phase 1 14 §5); dev/test hold synthetic data.
  #checkov:skip=CKV2_AWS_62:Event notifications for the upload pipeline are added at Gate 2/3 with the media-scanner.
  for_each            = local.buckets
  bucket              = "${var.name_prefix}-${each.key}"
  object_lock_enabled = each.value.object_lock
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arns[local.buckets[each.key].key]
    }
  }
}

resource "aws_s3_bucket_logging" "this" {
  for_each      = local.buckets
  bucket        = aws_s3_bucket.this[each.key].id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "${each.key}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    id     = "hygiene"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = local.buckets[each.key].noncurrent_days }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.this["audit-archive"].id
  rule {
    default_retention {
      mode = "GOVERNANCE" # dev/test: governance mode so synthetic data can be cleaned up; compliance mode in prod-like envs.
      days = 30
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "access_logs" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "AllowS3ServerAccessLogging"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.access_logs.json
}

data "aws_iam_policy_document" "tls_only" {
  for_each = local.buckets
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this[each.key].arn, "${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  for_each = data.aws_iam_policy_document.tls_only
  bucket   = aws_s3_bucket.this[each.key].id
  policy   = each.value.json
}

output "bucket_names" { value = { for k, b in aws_s3_bucket.this : k => b.bucket } }
