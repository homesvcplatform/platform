# VPC with three subnet tiers across 3 AZs (Phase 1 14 §2.2): public (NAT/ALB), private app, isolated data.
# Interface/gateway endpoints keep AWS API traffic private. Flow logs are KMS-encrypted.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name_prefix" { type = string }
variable "cidr_block" { type = string }
variable "logs_kms_key_arn" { type = string }
variable "single_nat_gateway" {
  type        = bool
  default     = true
  description = "dev/test use one NAT gateway to control cost; staging/prod-like use one per AZ."
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 3)
  tiers = {
    public = 0
    app    = 3
    data   = 6
  }
  subnets = merge([
    for tier, offset in local.tiers : {
      for i, az in local.azs : "${tier}-${i}" => { tier = tier, az = az, cidr = cidrsubnet(var.cidr_block, 4, offset + i) }
    }
  ]...)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name_prefix}-vpc" }
}

# Default security group with no rules (CIS): nothing may use it.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "this" {
  for_each                = local.subnets
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.value.az
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name_prefix}-${each.key}", tier = each.value.tier }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_eip" "nat" {
  #checkov:skip=CKV2_AWS_19:EIP is attached to the NAT gateway below.
  count  = var.single_nat_gateway ? 1 : 3
  domain = "vpc"
}

resource "aws_nat_gateway" "this" {
  count         = var.single_nat_gateway ? 1 : 3
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.this["public-${count.index}"].id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table" "app" {
  count  = 3
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
  }
}

# Data tier has no route to the internet at all.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
}

resource "aws_route_table_association" "this" {
  for_each       = local.subnets
  subnet_id      = aws_subnet.this[each.key].id
  route_table_id = each.value.tier == "public" ? aws_route_table.public.id : (each.value.tier == "app" ? aws_route_table.app[tonumber(split("-", each.key)[1])].id : aws_route_table.data.id)
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/hsp/${var.name_prefix}/vpc-flow-logs"
  retention_in_days = 365
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "flow_logs_write" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${var.name_prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json
}

resource "aws_iam_role_policy" "flow_logs" {
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs_write.json
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn    = aws_iam_role.flow_logs.arn
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name_prefix}-vpc-endpoints"
  description = "HTTPS from inside the VPC to interface endpoints"
  vpc_id      = aws_vpc.this.id
  ingress {
    description = "HTTPS from VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr_block]
  }
  egress {
    description = "Responses within the VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.cidr_block]
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, [aws_route_table.data.id])
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ecr.api", "ecr.dkr", "secretsmanager", "kms", "logs", "sts", "ssm"])
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "app"]
  security_group_ids  = [aws_security_group.endpoints.id]
}

output "vpc_id" { value = aws_vpc.this.id }
output "vpc_cidr" { value = var.cidr_block }
output "app_subnet_ids" { value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "app"] }
output "data_subnet_ids" { value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "data"] }
output "public_subnet_ids" { value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "public"] }
