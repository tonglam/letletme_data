# Overall

Letletme_data is a robust data service that fetches data from the Fantasy Premier League (FPL) servers, cleans and transforms the data, and then stores it in PostgreSQL and Redis, providing RESTful APIs for querying data. The service is built with TypeScript using functional programming principles, ensuring type safety and maintainability.

Key Features:

- Real-time FPL data fetching and transformation
- Clean, structured data through RESTful APIs
- Efficient data persistence with PostgreSQL
- Performance optimization using Redis caching
- Type-safe implementation with strict TypeScript
- Docker containerization for easy deployment

# Architecture & Workflow

## System Architecture

```mermaid
graph TB
    FPL[FPL API] --> |Raw Data| Fetcher[Data Fetcher]
    Fetcher --> |JSON| Transform[Data Transformer]
    Transform --> |Validated Data| Storage[Data Storage]
    Storage --> |Write| DB[(PostgreSQL)]
    Storage --> |Cache| Cache[(Redis)]
    API[REST API] --> |Read| Cache
    API --> |Read/Write| DB
    Cron[Cron Jobs] --> |Trigger| Fetcher

    subgraph Data Processing
        Fetcher
        Transform
        Storage
    end

    subgraph Data Access
        API
    end

    subgraph Scheduling
        Cron
    end
```

## Data Flow

```mermaid
sequenceDiagram
    participant C as Cron Job
    participant F as Fetcher
    participant T as Transformer
    participant P as PostgreSQL
    participant R as Redis
    participant A as API

    C->>F: Trigger data fetch
    F->>FPL: Request data
    FPL-->>F: Return raw data
    F->>T: Pass raw JSON
    T->>T: Validate & transform
    T->>P: Store processed data
    T->>R: Cache frequently accessed data

    Note over A,R: API Data Access Flow
    A->>R: Check cache
    alt Cache hit
        R-->>A: Return cached data
    else Cache miss
        A->>P: Query database
        P-->>A: Return data
        A->>R: Update cache
    end
```

## Data Processing Pipeline

```mermaid
flowchart LR
    A[Raw FPL Data] --> B[Validation Layer]
    B --> C[Transform Layer]
    C --> D[Business Logic]
    D --> E[Storage Layer]

    subgraph Validation
        B --> |zod| B1[Schema Validation]
    end

    subgraph Transform
        C --> |fp-ts| C1[Data Mapping]
        C --> |Either| C2[Error Handling]
    end

    subgraph Storage
        E --> E1[PostgreSQL]
        E --> E2[Redis Cache]
    end
```

# Tech Stack

Core:

- TypeScript (with strict type checking)
- Node.js (v18+)
- Bun (runtime & package manager)
- ElysiaJS (REST API framework)

Storage:

- PostgreSQL (primary database)
- Redis (caching layer, via ioredis)
- Drizzle ORM (type-safe ORM)

Testing & Quality:

- Bun Test Runner (Jest-compatible)
- ESLint & Prettier (code quality tools)

Utilities:

- Pino (structured logging)
- Zod (runtime type validation)
- fp-ts (functional programming utilities)

DevOps:

- Docker (containerization)
- Docker Compose (multi-container orchestration)

# Functional Programming

This project is designed using functional programming principles, making it particularly well-suited for data transformation workflows. The FP approach offers several benefits:

1. Data Flow:

   - Clear, unidirectional data flow
   - Immutable data transformations
   - Pure functions for predictable results
   - Extensive use of fp-ts for functional patterns

2. Type Safety:

   - Advanced TypeScript generics
   - No 'any' types allowed
   - Strong type inference
   - Runtime type validation with Zod

3. Benefits:
   - Highly testable code
   - Easy to maintain and extend
   - Reduced side effects
   - Better error handling through Either and Option types
   - Composable functions

While the learning curve with TypeScript generics and FP patterns can be steep, especially coming from an OOP background, the resulting codebase is more maintainable, predictable, and elegant.

# Getting Started

1. Prerequisites:

   ```bash
   Node.js v18+
   Bun v1+
   Docker & Docker Compose
   PostgreSQL
   Redis
   ```

2. Installation:

   ```bash
   git clone [repository-url]
   cd letletme_data
   bun install
   ```

3. Configuration:

   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

4. Run:
   ```bash
   docker-compose up -d
   bun run dev
   ```

# Domain-Driven Design

The project follows DDD principles with clear domain boundaries and type-safe implementations.

```mermaid
graph TB
    subgraph Core Domain
        Event[Event Domain]
        Player[Player Domain]
        Team[Team Domain]
        Entry[Entry Domain]
        League[League Domain]
    end

    subgraph Supporting Domains
        Scout[Scout Domain]
        Stats[Statistics Domain]
        Live[Live Domain]
    end

    Event --> Stats
    Player --> Stats
    Team --> Stats
    Entry --> Stats
    League --> Stats

    Stats --> Live
    Scout --> Live
```

Each domain follows a standard structure with entities, repositories, services, and types, ensuring clear separation of concerns and maintainable code. For detailed design documentation, please refer to the design docs.
