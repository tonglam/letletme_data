# Queue Layer Design

## Overview

The Queue Layer provides job scheduling and processing capabilities for the FPL data system, leveraging BullMQ's robust features while maintaining type safety and functional programming principles using fp-ts.

## System Architecture

```mermaid
graph TD
    subgraph Application Layer
        API[API Layer]
        Service[Service Layer]
        Domain[Domain Layer]
    end

    subgraph Queue Layer
        QS[Queue Service]
        WS[Worker Service]
        FS[Flow Service]
        SS[Scheduler Service]

        subgraph Core Services
            QA[Queue Adapter]
            WA[Worker Adapter]
            FA[Flow Adapter]
            SA[Scheduler Adapter]
        end

        subgraph BullMQ Integration
            BQ[BullMQ]
            Redis[(Redis)]
        end
    end

    API --> Service
    Service --> QS
    QS --> QA
    WS --> WA
    FS --> FA
    SS --> SA
    QA & WA & FA & SA --> BQ
    BQ --> Redis
```

## Core Components

### 1. Queue Layer Services

- **Queue Service**: Job management and scheduling
- **Worker Service**: Job processing and concurrency control
- **Flow Service**: Job flow and dependency management
- **Scheduler Service**: Recurring job scheduling

### 2. Job Types

```typescript
type JobType = 'META' | 'LIVE' | 'DAILY';
type JobOperation = 'SYNC' | 'UPDATE' | 'CLEANUP';
type MetaJobType = 'EVENTS' | 'PHASES' | 'TEAMS';

interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
}
```

## Queue Processing Patterns

### 1. Single Queue-Single Worker (1:1)

```mermaid
graph LR
    Q[Queue] --> W[Worker]
    W --> P[Processor]
```

### 2. Single Queue-Multiple Workers (1:N)

```mermaid
graph TD
    Q[Queue] --> W1[Worker 1]
    Q --> W2[Worker 2]
    Q --> W3[Worker 3]
```

### 3. Job Flow Pattern

```mermaid
graph TD
    P[Parent Job] --> C1[Child Job 1]
    P --> C2[Child Job 2]
    C1 --> GC[Grandchild Job]
```

## Service Interfaces

### 1. Queue Service

```typescript
interface QueueService<T> {
  addJob: (data: T, options?: JobOptions) => TaskEither<QueueError, void>;
  addBulk: (jobs: Array<{ data: T; options?: JobOptions }>) => TaskEither<QueueError, void>;
  removeJob: (jobId: string) => TaskEither<QueueError, void>;
  drain: () => TaskEither<QueueError, void>;
  pause: () => TaskEither<QueueError, void>;
  resume: () => TaskEither<QueueError, void>;
}
```

### 2. Worker Service

```typescript
interface WorkerService<T> {
  start: () => TaskEither<QueueError, void>;
  stop: () => TaskEither<QueueError, void>;
  pause: (force?: boolean) => TaskEither<QueueError, void>;
  resume: () => TaskEither<QueueError, void>;
  setConcurrency: (concurrency: number) => void;
}
```

### 3. Flow Service

```typescript
interface FlowService<T> {
  getFlowDependencies: (jobId: string) => TaskEither<QueueError, FlowJob<T>[]>;
  getChildrenValues: (jobId: string) => TaskEither<QueueError, Record<string, unknown>>;
  addJob: (data: T, opts?: FlowOpts<T>) => TaskEither<QueueError, FlowJob<T>>;
}
```

### 4. Scheduler Service

```typescript
interface SchedulerService<T> {
  upsertJobScheduler: (
    schedulerId: string,
    scheduleOptions: JobSchedulerOptions,
    template?: JobTemplate<T>,
  ) => TaskEither<QueueError, void>;
  getJobSchedulers: (options?: {
    page?: number;
    pageSize?: number;
  }) => TaskEither<QueueError, JobScheduler[]>;
}
```

## Job Processing Flow

```mermaid
sequenceDiagram
    participant S as Service Layer
    participant Q as Queue Service
    participant W as Worker Service
    participant P as Processor
    participant R as Redis

    S->>Q: Add Job
    Q->>R: Store Job
    W->>R: Poll Jobs
    W->>P: Process Job
    alt Success
        P-->>W: Complete
        W-->>R: Mark Complete
    else Error
        P-->>W: Fail
        W->>R: Schedule Retry
    end
```

## Error Handling Strategy

### 1. Error Types

```typescript
type QueueErrorCode =
  | 'QUEUE_CONNECTION_ERROR'
  | 'JOB_PROCESSING_ERROR'
  | 'QUEUE_OPERATION_ERROR'
  | 'WORKER_ERROR';
```

### 2. Error Flow

```mermaid
graph TD
    E[Error] --> QE[Queue Error]
    QE --> PE[Processing Error]
    QE --> CE[Connection Error]

    subgraph Error Handling
        R[Retry]
        L[Log]
        N[Notify]

        PE --> R
        PE --> L
        CE --> N
    end
```

## Performance Considerations

### 1. Resource Management

- Connection pooling
- Worker concurrency
- Memory limits
- Rate limiting

### 2. Scaling Strategy

```mermaid
graph TD
    L[Load] --> A{Analysis}
    A -->|High CPU| W[Add Workers]
    A -->|High Memory| M[Increase Memory]
    A -->|High Load| Q[Add Queues]
```

## Monitoring and Metrics

### 1. Key Metrics

- Queue length
- Processing time
- Error rates
- Worker status

### 2. Health Checks

```mermaid
graph TD
    H[Health Check] --> Q[Queue Status]
    H --> W[Worker Status]
    H --> R[Redis Status]
    H --> P[Processing Rate]
```

## Implementation Guidelines

### 1. Type Safety

- Use branded types
- Validate job data
- Type-safe processors
- Error type checking

### 2. Functional Programming

- Use TaskEither for operations
- Pure job processors
- Immutable job data
- Composition with fp-ts

### 3. Testing Strategy

- Unit test processors
- Integration test flows
- Mock Redis for tests
- Test error scenarios
