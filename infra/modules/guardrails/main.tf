# Account-level guardrails for dev/test workload accounts (Phase 2 Gate 1, SR-16, "no public buckets").
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
variable "deploy_role_arn" { type = string }
variable "enable_config_rules" {
  type        = bool
  default     = true
  description = "Requires an AWS Config recorder in the account (typically provided by the organisation / Control Tower)."
}

# Block public S3 access for the whole account, not just our buckets.
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}

# ---- Alerting: task definition / service changes by anyone other than the deploy role (SR-16 drift) ----
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "alerts_key" {
  #checkov:skip=CKV_AWS_109:Root-account key administration statement is the AWS-recommended baseline.
  #checkov:skip=CKV_AWS_111:Same baseline statement; key policies are scoped to this key.
  #checkov:skip=CKV_AWS_356:Key policies always apply to the key they are attached to.
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "EventBridgePublishToEncryptedTopic"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description             = "${var.name_prefix} security alerts topic"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.alerts_key.json
}

resource "aws_sns_topic" "security_alerts" {
  name              = "${var.name_prefix}-security-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
}

resource "aws_cloudwatch_event_rule" "ecs_out_of_band_change" {
  name        = "${var.name_prefix}-ecs-out-of-band-change"
  description = "ECS task definition/service changes not made by the CI deploy role"
  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventName    = ["RegisterTaskDefinition", "UpdateService", "CreateService", "DeleteService"]
      userIdentity = { sessionContext = { sessionIssuer = { arn = [{ "anything-but" = [var.deploy_role_arn] }] } } }
    }
  })
}

resource "aws_cloudwatch_event_target" "ecs_out_of_band_change" {
  rule = aws_cloudwatch_event_rule.ecs_out_of_band_change.name
  arn  = aws_sns_topic.security_alerts.arn
}

data "aws_iam_policy_document" "sns_events" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.security_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "security_alerts" {
  arn    = aws_sns_topic.security_alerts.arn
  policy = data.aws_iam_policy_document.sns_events.json
}

# ---- AWS Config managed rules ------------------------------------------------------------------------
resource "aws_config_config_rule" "managed" {
  for_each = var.enable_config_rules ? {
    s3-public-access-prohibited  = "S3_BUCKET_LEVEL_PUBLIC_ACCESS_PROHIBITED"
    s3-account-public-access     = "S3_ACCOUNT_LEVEL_PUBLIC_ACCESS_BLOCKS_PERIODIC"
    s3-ssl-requests-only         = "S3_BUCKET_SSL_REQUESTS_ONLY"
    rds-storage-encrypted        = "RDS_STORAGE_ENCRYPTED"
    rds-not-public               = "RDS_INSTANCE_PUBLIC_ACCESS_CHECK"
    ecr-immutable-tags           = "ECR_PRIVATE_TAG_IMMUTABILITY_ENABLED"
    iam-no-user-access-keys      = "IAM_USER_NO_POLICIES_CHECK"
    cloudtrail-enabled           = "CLOUD_TRAIL_ENABLED"
    ecs-task-def-nonroot         = "ECS_TASK_DEFINITION_NONROOT_USER"
    ecs-task-def-readonly-rootfs = "ECS_CONTAINERS_READONLY_ACCESS"
  } : {}
  name = "${var.name_prefix}-${each.key}"
  source {
    owner             = "AWS"
    source_identifier = each.value
  }
}

output "security_alerts_topic_arn" { value = aws_sns_topic.security_alerts.arn }
