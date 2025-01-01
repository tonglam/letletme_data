# Queue Layer Design

## Overview

The Queue Layer provides job scheduling and processing capabilities for the FPL data system, leveraging BullMQ's robust features while maintaining type safety and functional programming principles.

## System Integration Overview

```mermaid
graph TB
    subgraph Application Layers
        API[API Layer]
        Service[Service Layer]
        Domain[Domain Layer]
    end

    subgraph Queue Layer
        QS[Queue Service]
        WS[Worker Service]
        subgraph BullMQ Integration
            QA[Queue Adapter]
            WA[Worker Adapter]
            BQ[BullMQ]
        end
        subgraph Error Handling
            EH[Error Handler]
            EL[Error Logger]
        end
    end

    subgraph Storage
        Redis[(Redis)]
    end

    API --> Service
    Service --> Domain
    Service --> QS
    QS --> QA
    WS --> WA
    QA & WA --> BQ
    BQ --> Redis
    QA & WA --> EH
    EH --> EL
```

## Core Components

### 1. Queue Layer Components

- **Queue Service**: Simplified job management using BullMQ's native features
- **Worker Service**: Streamlined job processing with built-in error handling
- **Error Handler**: Essential error management with functional approach
- **Job Processors**: Type-safe job processing implementations

### 2. BullMQ Integration

- Leverages BullMQ's built-in features for:
  - Queue management
  - Job scheduling
  - Worker processing
  - Error handling and retries
  - Event management

## Queue Processing Patterns

### 1. Single Queue-Single Worker (1:1)

- Basic pattern for independent job types
- Each queue has its dedicated worker
- Used for simple, isolated job processing
- Best for jobs that need dedicated resources

### 2. Single Queue-Multiple Workers (1:N)

- For I/O intensive operations
- Multiple workers process jobs from one queue
- Enables parallel processing and better resource utilization
- Example use cases:
  - Heavy data processing
  - Batch operations
  - Network-intensive tasks
  - Large-scale data synchronization

### 3. Multiple Queues-Single Worker (N:1)

- For sequential processing requirements
- One worker handles multiple queues
- Ensures ordered processing across related operations
- Example use cases:
  - Data validation → transformation → persistence
  - Sequential workflow steps
  - Dependencies between jobs

```mermaid
graph TB
    subgraph "Queue Processing Patterns"
        subgraph "1:1 Pattern"
            Q1[Queue] --> W1[Worker]
        end

        subgraph "1:N Pattern"
            Q2[Queue] --> W2_1[Worker 1]
            Q2 --> W2_2[Worker 2]
            Q2 --> W2_3[Worker 3]
        end

        subgraph "N:1 Pattern"
            Q3_1[Queue 1] --> W3[Worker]
            Q3_2[Queue 2] --> W3
            Q3_3[Queue 3] --> W3
        end
    end
```

## Job Processing Flow

```mermaid
sequenceDiagram
    participant S as Service Layer
    participant Q as Queue Service
    participant W as Worker Service
    participant B as BullMQ
    participant R as Redis

    S->>Q: Add Job
    Q->>B: Queue Job
    B->>R: Store Job
    W->>B: Poll Jobs
    B->>W: Process Job
    alt Success
        W->>B: Complete Job
    else Error
        W->>B: Handle Retry
        B->>W: Retry Job
    end
```

## Job Categories

```mermaid
graph TB
    subgraph Job Types
        M[Meta Jobs<br>Core Data Sync]
        L[Live Jobs<br>Real-time Updates]
        PM[Post-Match Jobs<br>Results Processing]
        PG[Post-Gameweek Jobs<br>Tournament Updates]
        D[Daily Jobs<br>Regular Updates]
    end

    subgraph Processing
        HP[High Priority Queue]
        MP[Medium Priority Queue]
        LP[Low Priority Queue]
    end

    M & L --> HP
    PM & PG --> MP
    D --> LP
```

## Implementation Considerations

### 1. Resource Management

- CPU/Memory allocation per worker
- I/O capacity planning
- Redis connection pooling
- Worker concurrency settings

### 2. Job Priority Management

- Queue priority levels
- Job priority within queues
- Resource allocation based on priority
- Handling priority conflicts

### 3. Scaling Strategies

- When to use each pattern
- Monitoring and metrics
- Dynamic scaling based on load
- Resource limits and constraints

### 4. Error Handling Strategy

- Retry mechanisms
- Error logging and monitoring
- Circuit breakers
- Fallback strategies

### 5. Performance Optimization

- Queue configuration tuning
- Worker pool management
- Job batching strategies
- Memory management

## Monitoring

### Key Metrics

1. **Queue Metrics**

   - Queue length
   - Processing time
   - Success/failure rates
   - Job distribution

2. **Worker Metrics**

   - Active workers
   - Job completion rate
   - Error distribution
   - Resource utilization

3. **System Health**
   - Redis connection status
   - Memory usage
   - Job backlog
   - System load

## Implementation Guidelines

### 1. Functional Programming

- Use TaskEither for operations
- Maintain immutability
- Leverage BullMQ's promise-based API with fp-ts

### 2. Type Safety

- Strong typing for job data
- Type-safe queue operations
- Comprehensive error types

### 3. Error Handling

- Utilize BullMQ's built-in retry mechanisms
- Functional error handling with TaskEither
- Structured logging

### 4. Performance

- Efficient queue configuration
- Optimal concurrency settings
- Resource-aware job processing
