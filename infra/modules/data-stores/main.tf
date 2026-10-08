# PostgreSQL (system of record, ADR-002) and Valkey (ephemeral only) in isolated data subnets.
# dev/test are single-AZ for cost; staging/prod-like use Multi-AZ (Phase 1 14 §2.2).
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws" }
    random = { source = "hashicorp/random" }
  }
}

variable "name_prefix" { type = string }
variable "vpc_id" { type = string }
variable "data_subnet_ids" { type = list(string) }
variable "app_security_group_id" { type = string }
variable "db_kms_key_arn" { type = string }
variable "secrets_kms_key_arn" { type = string }
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "multi_az" {
  type    = bool
  default = false
}
variable "backup_retention_days" {
  type    = number
  default = 7
}

# ---- PostgreSQL ------------------------------------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.data_subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db"
  description = "PostgreSQL reachable only from application tasks"
  vpc_id      = var.vpc_id
  ingress {
    description     = "PostgreSQL from app tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name_prefix}-pg17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements,pgaudit"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "pgaudit.log"
    value = "ddl,role"
  }
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${var.name_prefix}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:dev/test are single-AZ by design (cost); Multi-AZ is mandatory for staging/prod-like (Phase 1 14 §2.2).
  identifier                            = "${var.name_prefix}-postgres"
  engine                                = "postgres"
  engine_version                        = "17"
  instance_class                        = var.db_instance_class
  allocated_storage                     = 20
  max_allocated_storage                 = 100
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = var.db_kms_key_arn
  db_name                               = "hsp"
  username                              = "hsp_admin"
  manage_master_user_password           = true
  master_user_secret_kms_key_id         = var.secrets_kms_key_arn
  iam_database_authentication_enabled   = true
  db_subnet_group_name                  = aws_db_subnet_group.this.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.this.name
  publicly_accessible                   = false
  multi_az                              = var.multi_az
  backup_retention_period               = var.backup_retention_days
  copy_tags_to_snapshot                 = true
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${var.name_prefix}-postgres-final"
  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.db_kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
}

# ---- Valkey (ephemeral state only: rate limits, call state, locks) -----------------------------------
resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name_prefix}-valkey"
  subnet_ids = var.data_subnet_ids
}

resource "aws_security_group" "valkey" {
  name        = "${var.name_prefix}-valkey"
  description = "Valkey reachable only from application tasks"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Valkey from app tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
}

resource "random_password" "valkey_auth" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "valkey_auth" {
  #checkov:skip=CKV2_AWS_57:Valkey AUTH token rotation is a Gate 3 runbook item (requires coordinated client rollout).
  name       = "${var.name_prefix}/valkey/auth-token"
  kms_key_id = var.secrets_kms_key_arn
}

resource "aws_secretsmanager_secret_version" "valkey_auth" {
  secret_id     = aws_secretsmanager_secret.valkey_auth.id
  secret_string = random_password.valkey_auth.result
}

resource "aws_elasticache_replication_group" "this" {
  #checkov:skip=CKV2_AWS_50:Single-node Valkey in dev/test (ephemeral data only); Multi-AZ failover in staging/prod-like.
  replication_group_id       = "${var.name_prefix}-valkey"
  description                = "${var.name_prefix} ephemeral state"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.valkey.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = var.secrets_kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = random_password.valkey_auth.result
  automatic_failover_enabled = false
  snapshot_retention_limit   = 0
  apply_immediately          = true
}

output "db_endpoint" { value = aws_db_instance.this.address }
output "db_master_secret_arn" { value = aws_db_instance.this.master_user_secret[0].secret_arn }
output "valkey_primary_endpoint" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "valkey_auth_secret_arn" { value = aws_secretsmanager_secret.valkey_auth.arn }
