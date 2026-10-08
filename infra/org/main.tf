# Organisation-level guardrails (Service Control Policies), applied from the AWS Organizations management account
# by a founder/security admin (Phase 1 14 §2.1, SR-16). All three SCPs attach to the Workloads OU (dev/test).
# The region and security baselines also attach to the Infrastructure OU (shared-services account, Gate 1 I-6).
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
  backend "s3" {}
}

variable "management_account_id" { type = string }
variable "workloads_ou_id" {
  type        = string
  description = "OU id (ou-xxxx-xxxxxxxx) containing the dev/test workload accounts."
}
variable "infrastructure_ou_id" {
  type        = string
  description = "OU id (ou-xxxx-xxxxxxxx) containing the shared-services account."
}

provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = [var.management_account_id]
}

locals {
  scps = {
    # SR-16: only the CI deploy role (hsp-<env>-deploy) may register task definitions or change ECS services.
    hsp-deploy-path-only = {
      Version = "2012-10-17"
      Statement = [{
        Sid      = "OnlyPipelineDeployRoleChangesEcs"
        Effect   = "Deny"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:RunTask"]
        Resource = "*"
        Condition = {
          ArnNotLike = { "aws:PrincipalArn" = ["arn:aws:iam::*:role/hsp-*-deploy", "arn:aws:iam::*:role/OrganizationAccountAccessRole"] }
        }
      }]
    }
    # Data residency: only Mumbai (primary) and Hyderabad (DR), except global services.
    hsp-region-allowlist = {
      Version = "2012-10-17"
      Statement = [{
        Sid    = "DenyOutsideIndiaRegions"
        Effect = "Deny"
        NotAction = [
          "iam:*", "organizations:*", "sts:*", "support:*", "budgets:*", "ce:*", "cloudfront:*", "route53:*",
          "route53domains:*", "waf:*", "wafv2:*", "shield:*", "health:*", "trustedadvisor:*", "account:*",
          "kms:*", "s3:GetAccountPublicAccessBlock", "s3:PutAccountPublicAccessBlock", "sso:*", "identitystore:*",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = ["ap-south-1", "ap-south-2"] } }
      }]
    }
    hsp-security-baseline = {
      Version = "2012-10-17"
      Statement = [
        {
          Sid      = "ProtectSecurityServices"
          Effect   = "Deny"
          Action   = ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "guardduty:DeleteDetector", "guardduty:DisassociateFromMasterAccount", "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "securityhub:DisableSecurityHub"]
          Resource = "*"
        },
        {
          Sid      = "NoLeavingOrganization"
          Effect   = "Deny"
          Action   = ["organizations:LeaveOrganization"]
          Resource = "*"
        },
        {
          Sid      = "NoIamUserAccessKeys"
          Effect   = "Deny"
          Action   = ["iam:CreateAccessKey", "iam:CreateUser"]
          Resource = "*"
        },
        {
          Sid       = "NoPublicS3Changes"
          Effect    = "Deny"
          Action    = ["s3:PutAccountPublicAccessBlock", "s3:DeletePublicAccessBlock"]
          Resource  = "*"
          Condition = { ArnNotLike = { "aws:PrincipalArn" = ["arn:aws:iam::*:role/OrganizationAccountAccessRole"] } }
        },
        {
          Sid       = "RequireImdsV2"
          Effect    = "Deny"
          Action    = ["ec2:RunInstances"]
          Resource  = "arn:aws:ec2:*:*:instance/*"
          Condition = { StringNotEquals = { "ec2:MetadataHttpTokens" = "required" } }
        },
        {
          Sid       = "DenyRootUser"
          Effect    = "Deny"
          Action    = "*"
          Resource  = "*"
          Condition = { StringLike = { "aws:PrincipalArn" = ["arn:aws:iam::*:root"] } }
        },
      ]
    }
  }
}

resource "aws_organizations_policy" "scp" {
  for_each    = local.scps
  name        = each.key
  description = "Phase 2 guardrail: ${each.key}"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(each.value)
}

resource "aws_organizations_policy_attachment" "workloads" {
  for_each  = aws_organizations_policy.scp
  policy_id = each.value.id
  target_id = var.workloads_ou_id
}

# I-6: the same region and security baseline for the shared-services account (registry + CI build role).
# hsp-deploy-path-only is not attached here: no ECS workloads run in shared-services.
resource "aws_organizations_policy_attachment" "infrastructure" {
  for_each  = toset(["hsp-region-allowlist", "hsp-security-baseline"])
  policy_id = aws_organizations_policy.scp[each.key].id
  target_id = var.infrastructure_ou_id
}
