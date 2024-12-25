# Domain Development Guide

This guide outlines the process of implementing a new domain in the application, using the `teams` domain as a reference implementation.

## 1. Domain Structure

### 1.1 Directory Structure

```
src/
├── types/
│   ├── teams.type.ts      # Domain types and transformers
│   └── [domain].type.ts   # Each domain has its own type file
├── domains/
│   └── [domain]/
│       ├── index.ts       # Domain exports
│       ├── routes.ts      # HTTP routes
│       ├── operations.ts  # Domain operations
│       ├── repository.ts  # Data access layer
│       └── cache/
│           ├── cache.ts        # Cache operations
│           └── invalidation.ts # Cache invalidation
└── services/
    └── [domain]/
        ├── index.ts    # Service exports
        ├── types.ts    # Service types
        ├── service.ts  # Core implementation
        ├── workflow.ts # Business workflows
        └── cache.ts    # Cache initialization
```

### 1.2 Layer Responsibilities

- **Types**: Domain models, transformers, and validations
- **Domain**: Core business logic and data access
- **Service**: Business workflows and orchestration
- **Cache**: Data caching and invalidation
- **Repository**: Data persistence and retrieval

## 2. Job Implementation

### 2.1 Job Service Structure

```typescript
// services/queue/meta/[domain].job.ts

export class DomainJobService {
  constructor(
    private readonly metaQueue: MetaQueueService,
    private readonly domainRepo: DomainRepository,
  ) {}

  // Process job based on operation type
  processDomainJob = (job: Job<MetaJobData>): TE.TaskEither<Error, void> => {
    const { operation, id, options } = job.data.data;

    switch (operation) {
      case JobOperation.UPDATE:
        return this.handleUpdate(id, options);
      case JobOperation.SYNC:
        return this.handleSync(options);
      case JobOperation.DELETE:
        return this.handleDelete(id);
      default:
        return TE.left(createQueueProcessingError({ message: `Unknown operation: ${operation}` }));
    }
  };

  // Schedule jobs
  scheduleDomainUpdate = (
    id: number,
    options?: JobOptions,
  ): TE.TaskEither<Error, Job<MetaJobData>> =>
    this.metaQueue.addDomainJob({
      data: {
        operation: JobOperation.UPDATE,
        id,
        options,
      },
    });

  // ... other scheduling methods
}

// Create and export singleton instance
const metaQueue = createMetaQueueService();
export const domainJobService = new DomainJobService(metaQueue, domainRepository);
```

### 2.2 Job Registration

```typescript
// src/index.ts

const worker = createMetaWorkerService(
  {
    process: (job) => {
      switch (job.data.type) {
        case QUEUE_JOB_TYPES.EVENTS:
          return eventJobService.processEventsJob(job);
        case QUEUE_JOB_TYPES.TEAMS:
          return teamJobService.processTeamsJob(job);
        case QUEUE_JOB_TYPES.PHASES:
          return phaseJobService.processPhasesJob(job);
        default:
          return TE.left(new Error(`Unknown job type: ${job.data.type}`));
      }
    },
    onCompleted: (job) => logger.info({ jobId: job.id }, 'Job completed'),
    onFailed: (job, error) => logger.error({ jobId: job.id, error }, 'Job failed'),
    onError: (error) => logger.error({ error }, 'Worker error'),
  },
  META_QUEUE_CONFIG,
);
```

## 3. Route Implementation

### 3.1 Route Structure

```typescript
// domains/[domain]/routes.ts

export const domainRouter = Router();

// Create dependencies
const bootstrapApi = createFPLClient();
const domainService = createDomainServiceImpl({
  bootstrapApi,
  domainRepository,
});
const workflows = domainWorkflows(domainService);
const operations = createDomainOperations();

// Helper functions
const handleApiResponse = <T>(task: TE.TaskEither<APIError, T>) =>
  pipe(
    task,
    TE.map((data) => ({ status: 'success', data })),
    TE.mapLeft((error) => ({ status: 'error', error: error.message })),
  );

const toAPIError = (error: Error): APIError =>
  createInternalServerError({ message: error.message });

// Basic CRUD endpoints
domainRouter.get('/', async (_req, res) => {
  const result = await handleApiResponse(operations.getAll())();
  // ... handle response
});

// Workflow-based endpoints
domainRouter.post('/sync', async (_req, res) => {
  const result = await handleApiResponse(workflows.syncAndVerify())();
  // ... handle response
});

// Job-based endpoints
domainRouter.post('/jobs/sync', async (_req, res) => {
  const result = await handleApiResponse(
    pipe(domainJobService.scheduleSync(), TE.mapLeft(toAPIError)),
  )();
  // ... handle response
});
```

### 3.2 Route Registration

```typescript
// src/index.ts

// Register routes
app.use('/api/phases', phaseRouter);
app.use('/api/events', eventRouter);
app.use('/api/teams', teamRouter);
app.use('/api/monitor', monitorRouter);
```

## 4. Implementation Best Practices

### 4.1 Job Implementation

- Create a dedicated job service for each domain
- Implement standard operations (UPDATE, SYNC, DELETE)
- Export a singleton instance
- Use TaskEither for error handling
- Follow consistent naming patterns

### 4.2 Route Implementation

- Export a router instance directly (not a factory function)
- Group endpoints by type (CRUD, workflow, jobs)
- Use consistent error handling and response formats
- Implement proper type conversions
- Follow RESTful conventions

### 4.3 Error Handling

- Use TaskEither for functional error handling
- Convert between Error and APIError types
- Provide meaningful error messages
- Use appropriate HTTP status codes

### 4.4 Dependency Management

- Create dependencies at router level
- Use dependency injection
- Follow singleton pattern for services
- Maintain clear dependency boundaries

## 5. Testing Strategy

### 5.1 Job Tests

```typescript
describe('DomainJobService', () => {
  describe('processDomainJob', () => {
    it('should process UPDATE operation', async () => {
      // Test job processing
    });
  });

  describe('scheduleDomainUpdate', () => {
    it('should schedule update job', async () => {
      // Test job scheduling
    });
  });
});
```

### 5.2 Route Tests

```typescript
describe('Domain Routes', () => {
  describe('GET /', () => {
    it('should return all items', async () => {
      // Test GET endpoint
    });
  });

  describe('POST /jobs/sync', () => {
    it('should schedule sync job', async () => {
      // Test job endpoint
    });
  });
});
```
