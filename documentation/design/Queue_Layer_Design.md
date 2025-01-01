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

## Error Handling Strategy

```mermaid
sequenceDiagram
    participant J as Job
    participant W as Worker
    participant B as BullMQ
    participant L as Logger

    J->>W: Process
    alt Success
        W->>B: Complete
        B->>L: Log Success
    else Error
        W->>B: Handle Error
        B->>L: Log Error
        alt Retryable
            B->>J: Retry with Backoff
        else Non-Retryable
            B->>L: Log Final Failure
        end
    end
```

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

## Monitoring

### Key Metrics

1. **Queue Metrics**

   - Queue length
   - Processing time
   - Success/failure rates

2. **Worker Metrics**

   - Active workers
   - Job completion rate
   - Error distribution

3. **System Health**
   - Redis connection status
   - Memory usage
   - Job backlog
