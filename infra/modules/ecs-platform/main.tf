# ECS cluster, per-role log groups and least-privilege task roles (Phase 1 14 §2.2, §2.5).
# Images come from the shared-services registry (Phase 1 14 §2.1, I-2); the execution role pulls cross-account.
# ECS services are created at Gate 3 when roles serve traffic; Gate 1 only provides the platform.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "logs_kms_key_arn" { type = string }
variable "ecr_repository_arn" {
  type        = string
  description = "Shared backend repository in the shared-services account (infra/modules/registry, I-2)."
}
variable "ecr_kms_key_arn" {
  type        = string
  description = "Shared registry KMS key in the shared-services account."
}
variable "process_roles" {
  type    = list(string)
  default = ["api", "admin-api", "webhook", "voice", "worker", "scheduler", "media-scanner"]
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "role" {
  for_each          = toset(var.process_roles)
  name              = "/hsp/${var.environment}/${each.key}"
  retention_in_days = 365 # CERT-In requires >= 180 days in India (Phase 1.1 X-23); 365 keeps margin.
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull the image, write logs. No data access.
resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken does not support resource-level permissions.
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [var.ecr_repository_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.ecr_kms_key_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for g in aws_cloudwatch_log_group.role : "${g.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# One task role per process role (blast-radius isolation). Gate 1 grants nothing beyond the trust policy;
# each later gate adds exactly the data-class/KMS/bucket grants its role needs (SR-06).
resource "aws_iam_role" "task" {
  for_each           = toset(var.process_roles)
  name               = "${var.name_prefix}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = { process_role = each.key }
}

resource "aws_security_group" "app" {
  #checkov:skip=CKV2_AWS_5:Attached to the ECS services created at Gate 3 (no services exist in Gate 1). Remove this skip at Gate 3.
  name        = "${var.name_prefix}-app-tasks"
  description = "Application tasks: no inbound by default; egress HTTPS for AWS endpoints and the egress proxy"
  vpc_id      = var.vpc_id
  egress {
    description = "HTTPS (VPC endpoints, NAT/egress proxy)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "PostgreSQL and Valkey inside the VPC"
    from_port   = 5432
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
}

output "cluster_arn" { value = aws_ecs_cluster.this.arn }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "task_role_arns" { value = { for k, r in aws_iam_role.task : k => r.arn } }
output "app_security_group_id" { value = aws_security_group.app.id }
