# dev environment (Phase 2). Region ap-south-1 only. There is no production environment in Phase 2.
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.66" }
    random = { source = "hashicorp/random", version = "~> 3.8" }
  }
  # Partial configuration: bucket/key/dynamodb table are supplied with -backend-config at init (no secrets in code).
  backend "s3" {}
}

variable "account_id" {
  type        = string
  description = "The dev AWS account id. The provider refuses to run against any other account."
}

variable "github_repository" {
  type        = string
  default     = "homesvcplatform/platform"
  description = "owner/repo used in OIDC trust conditions (ADR-021 neutral name, I-7). Exact name only: no wildcards."
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be an exact owner/repo with no wildcards."
  }
}

variable "create_oidc_provider" {
  type    = bool
  default = true
}

# Shared-services registry (Phase 1 14 §2.1, I-2 Option A). Copy from `terraform output workload_inputs` in
# infra/envs/shared-services. Images are pulled cross-account; this account has no registry of its own.
variable "shared_ecr_repository_arn" {
  type        = string
  description = "ARN of the shared backend ECR repository (shared-services account)."
  validation {
    condition     = can(regex("^arn:aws:ecr:ap-south-1:[0-9]{12}:repository/hsp-shared-backend$", var.shared_ecr_repository_arn))
    error_message = "shared_ecr_repository_arn must be the hsp-shared-backend repository ARN in ap-south-1."
  }
}

variable "shared_ecr_repository_url" {
  type        = string
  description = "URL of the shared backend ECR repository (shared-services account)."
  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ap-south-1\\.amazonaws\\.com/hsp-shared-backend$", var.shared_ecr_repository_url))
    error_message = "shared_ecr_repository_url must be the hsp-shared-backend repository URL in ap-south-1."
  }
}

variable "shared_ecr_kms_key_arn" {
  type        = string
  description = "ARN of the shared registry KMS key (shared-services account)."
  validation {
    condition     = can(regex("^arn:aws:kms:ap-south-1:[0-9]{12}:key/[0-9a-f-]{36}$", var.shared_ecr_kms_key_arn))
    error_message = "shared_ecr_kms_key_arn must be a KMS key ARN in ap-south-1."
  }
}

locals {
  environment = "dev"
  name_prefix = "hsp-dev"
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
  cidr_block       = "10.20.0.0/16"
  logs_kms_key_arn = module.kms.key_arns["logs"]
}

module "storage" {
  source       = "../../modules/storage"
  name_prefix  = local.name_prefix
  kms_key_arns = module.kms.key_arns
}

module "ecs_platform" {
  source             = "../../modules/ecs-platform"
  name_prefix        = local.name_prefix
  environment        = local.environment
  vpc_id             = module.network.vpc_id
  vpc_cidr           = module.network.vpc_cidr
  logs_kms_key_arn   = module.kms.key_arns["logs"]
  ecr_repository_arn = var.shared_ecr_repository_arn
  ecr_kms_key_arn    = var.shared_ecr_kms_key_arn
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
  ecr_repository_arn   = var.shared_ecr_repository_arn
  ecr_kms_key_arn      = var.shared_ecr_kms_key_arn
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
  description = "Values to set as GitHub environment variables (not secrets). AWS_CI_ROLE_ARN comes from shared-services."
  value = {
    AWS_DEPLOY_ROLE_ARN     = module.ci_oidc.deploy_role_arn
    ECR_REPOSITORY_URI      = var.shared_ecr_repository_url
    TASK_EXECUTION_ROLE_ARN = module.ecs_platform.execution_role_arn
    AWS_ACCOUNT_ID          = var.account_id
  }
}
