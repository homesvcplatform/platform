# shared-services account (Phase 1 14 §2.1, Infrastructure OU): the single backend image registry and the CI build
# role (Gate 1 I-2 Option A, ADR-022 #11). Holds no application data. Region ap-south-1 only.
# Apply this before infra/envs/{dev,test}: they consume the outputs below as explicit inputs.
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.66" }
  }
  # Partial configuration: bucket/key are supplied with -backend-config at init (no secrets in code).
  backend "s3" {}
}

variable "account_id" {
  type        = string
  description = "The shared-services AWS account id. The provider refuses to run against any other account."
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

variable "consumer_account_ids" {
  type        = list(string)
  description = "dev and test workload account ids allowed to pull images. Empty until those accounts exist (TE-01). Never placeholders."
}

variable "create_oidc_provider" {
  type    = bool
  default = true
}

locals {
  name_prefix = "hsp-shared"
}

provider "aws" {
  region              = "ap-south-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = {
      project     = "homesvcplatform"
      environment = "shared-services"
      managed_by  = "terraform"
      data        = "none"
    }
  }
}

module "registry" {
  source               = "../../modules/registry"
  name_prefix          = local.name_prefix
  consumer_account_ids = var.consumer_account_ids
}

module "ci_build" {
  source               = "../../modules/ci-build"
  name_prefix          = local.name_prefix
  github_repository    = var.github_repository
  create_oidc_provider = var.create_oidc_provider
  ecr_repository_arn   = module.registry.repository_arn
  ecr_kms_key_arn      = module.registry.kms_key_arn
}

output "github_variables" {
  description = "Values to set as GitHub repository variables (not secrets)."
  value = {
    AWS_CI_ROLE_ARN    = module.ci_build.ci_build_role_arn
    ECR_REPOSITORY_URI = module.registry.repository_url
  }
}

output "workload_inputs" {
  description = "Values for shared_ecr_* in infra/envs/{dev,test}/terraform.tfvars."
  value = {
    shared_ecr_repository_arn = module.registry.repository_arn
    shared_ecr_repository_url = module.registry.repository_url
    shared_ecr_kms_key_arn    = module.registry.kms_key_arn
  }
}
