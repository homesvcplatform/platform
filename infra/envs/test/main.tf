# test environment (Phase 2). Region ap-south-1 only. There is no production environment in Phase 2.
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.66" }
    random = { source = "hashicorp/random", version = "~> 3.8" }
  }
  # Partial configuration: bucket/key/dynamodb table are supplied with -backend-config at init (no secrets in code).
  backend "s3" {}
}

variable "account_id" {
  type        = string
  description = "The test AWS account id. The provider refuses to run against any other account."
}

variable "github_repository" {
  type        = string
  description = "owner/repo used in OIDC trust conditions."
}

variable "create_oidc_provider" {
  type    = bool
  default = true
}

locals {
  environment = "test"
  name_prefix = "hsp-test"
}

provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = {
      project     = "homesvcplatform"
      environment = local.environment
      managed_by  = "terraform"
      data        = "synthetic-only"
    }
  }
}

module "kms" {
  source      = "../../modules/kms"
  name_prefix = local.name_prefix
}

module "network" {
  source           = "../../modules/network"
  name_prefix      = local.name_prefix
  cidr_block       = "10.30.0.0/16"
  logs_kms_key_arn = module.kms.key_arns["logs"]
}

module "storage" {
  source       = "../../modules/storage"
  name_prefix  = local.name_prefix
  kms_key_arns = module.kms.key_arns
}

module "ecs_platform" {
  source           = "../../modules/ecs-platform"
  name_prefix      = local.name_prefix
  environment      = local.environment
  vpc_id           = module.network.vpc_id
  vpc_cidr         = module.network.vpc_cidr
  logs_kms_key_arn = module.kms.key_arns["logs"]
  ecr_kms_key_arn  = module.kms.key_arns["ecr"]
}

module "data_stores" {
  source                = "../../modules/data-stores"
  name_prefix           = local.name_prefix
  vpc_id                = module.network.vpc_id
  data_subnet_ids       = module.network.data_subnet_ids
  app_security_group_id = module.ecs_platform.app_security_group_id
  db_kms_key_arn        = module.kms.key_arns["db"]
  secrets_kms_key_arn   = module.kms.key_arns["secrets"]
}

module "secrets" {
  source              = "../../modules/secrets"
  name_prefix         = local.name_prefix
  secrets_kms_key_arn = module.kms.key_arns["secrets"]
}

module "ci_oidc" {
  source               = "../../modules/ci-oidc"
  name_prefix          = local.name_prefix
  environment          = local.environment
  github_repository    = var.github_repository
  create_oidc_provider = var.create_oidc_provider
  ecr_repository_arn   = module.ecs_platform.ecr_repository_arn
  ecr_kms_key_arn      = module.kms.key_arns["ecr"]
  cluster_arn          = module.ecs_platform.cluster_arn
  execution_role_arn   = module.ecs_platform.execution_role_arn
  task_role_arns       = module.ecs_platform.task_role_arns
}

module "guardrails" {
  source          = "../../modules/guardrails"
  name_prefix     = local.name_prefix
  deploy_role_arn = module.ci_oidc.deploy_role_arn
}

output "github_variables" {
  description = "Values to set as GitHub repository/environment variables (not secrets)."
  value = {
    AWS_CI_ROLE_ARN         = module.ci_oidc.ci_build_role_arn
    AWS_DEPLOY_ROLE_ARN     = module.ci_oidc.deploy_role_arn
    ECR_REPOSITORY_URI      = module.ecs_platform.ecr_repository_url
    TASK_EXECUTION_ROLE_ARN = module.ecs_platform.execution_role_arn
    AWS_ACCOUNT_ID          = var.account_id
  }
}
