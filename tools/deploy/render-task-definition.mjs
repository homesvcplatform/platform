#!/usr/bin/env node
// Renders an ECS Fargate task definition for one process role. Used only by .github/workflows/deploy.yml.
// Security defaults: digest-pinned image, non-root user, read-only root filesystem, no privilege escalation,
// awsvpc networking, per-role task role, logs to a KMS-encrypted per-role log group.
const [target, role, image] = process.argv.slice(2);
const ROLES = new Set(['api', 'admin-api', 'webhook', 'voice', 'worker', 'scheduler', 'media-scanner']);

function fail(message) {
  console.error(message);
  process.exit(2);
}
if (!['dev', 'test'].includes(target)) fail('target must be dev or test');
if (!ROLES.has(role)) fail(`unknown role ${role}`);
if (!/@sha256:[0-9a-f]{64}$/.test(image ?? '')) fail('image must be pinned by digest');
const account = process.env.AWS_ACCOUNT_ID ?? '';
if (!/^\d{12}$/.test(account)) fail('AWS_ACCOUNT_ID must be set');
const executionRoleArn = process.env.TASK_EXECUTION_ROLE_ARN ?? '';
if (!executionRoleArn.startsWith('arn:aws:iam::')) fail('TASK_EXECUTION_ROLE_ARN must be set');

const name = `hsp-${target}-${role}`;
const definition = {
  family: name,
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  cpu: '256',
  memory: '512',
  runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'X86_64' },
  executionRoleArn,
  taskRoleArn: `arn:aws:iam::${account}:role/${name}-task`,
  containerDefinitions: [
    {
      name: role,
      image,
      essential: true,
      command: [`apps/${role}/src/main.ts`],
      user: '65532:65532',
      readonlyRootFilesystem: true,
      linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
      portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
      environment: [
        { name: 'APP_ENV', value: target },
        { name: 'APP_ROLE', value: role },
        { name: 'PORT', value: '8080' },
        { name: 'AWS_REGION', value: 'ap-south-1' },
        { name: 'AWS_ACCOUNT_ID', value: account },
        { name: 'NONPROD_AWS_ACCOUNT_IDS', value: account },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: { 'awslogs-group': `/hsp/${target}/${role}`, 'awslogs-region': 'ap-south-1', 'awslogs-stream-prefix': role },
      },
    },
  ],
  tags: [
    { key: 'project', value: 'homesvcplatform' },
    { key: 'environment', value: target },
    { key: 'role', value: role },
  ],
};
process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`);
