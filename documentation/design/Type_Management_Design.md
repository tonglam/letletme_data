# Type Management Design

## Overview

This document outlines our approach to managing types in the application, ensuring type safety, validation, and clean architecture through functional programming principles and branded types.

## Type System Architecture

```mermaid
graph TD
    A[Base Types] --> B[Domain Types]
    A --> C[Branded Types]
    A --> D[Repository Types]
    B --> E[Service Types]
    C --> F[Type Guards]
    D --> G[Database Types]

    subgraph Type Hierarchy
        H[Core Types]
        I[Domain Models]
        J[Infrastructure Types]
        K[API Types]

        H --> I
        I --> J
        J --> K
    end
```

## Type Categories

### 1. Base Types (`src/types/base.type.ts`)

```mermaid
graph TD
    A[Base Types] --> B[Branded Types]
    A --> C[Repository Interface]
    A --> D[Validation Helpers]
    A --> E[Cache Handlers]

    subgraph Core Types
        F[Brand Interface]
        G[Type Guards]
        H[Error Types]
        I[Utility Types]

        F --> G
        G --> H
        H --> I
    end
```

### 2. Domain Types (`src/types/{domain}.type.ts`)

```mermaid
graph TD
    A[Domain Types] --> B[API Types]
    A --> C[Domain Models]
    A --> D[Database Types]
    A --> E[Type Converters]

    subgraph Domain Layer
        F[Branded IDs]
        G[Validation]
        H[Conversion]
        I[Schemas]

        F --> G
        G --> H
        H --> I
    end
```

## Type Flow

```mermaid
sequenceDiagram
    participant API as API Response
    participant Val as Validation
    participant Dom as Domain Model
    participant DB as Database Model

    API->>Val: Validate Schema
    Val->>Dom: Convert to Domain
    Dom->>DB: Map to Database
    DB-->>Dom: Map to Domain
    Dom-->>API: Format Response
```

## Type Definitions

### 1. Branded Types

```typescript
interface Brand<K extends string> {
  readonly __brand: K;
}

type Branded<T, K extends string> = T & Brand<K>;

const createBrandedType = <T, K extends string>(
  brand: K,
  validator: (value: unknown) => value is T,
) => ({
  validate: (value: unknown): Either<string, Branded<T, K>>,
  is: (value: unknown): value is Branded<T, K>,
});
```

### 2. Repository Types

```typescript
interface BaseRepository<T, CreateT, IdT> {
  readonly findAll: () => TaskEither<DBError, T[]>;
  readonly findById: (id: IdT) => TaskEither<DBError, T | null>;
  readonly save: (data: CreateT) => TaskEither<DBError, T>;
  readonly saveBatch: (data: CreateT[]) => TaskEither<DBError, T[]>;
  readonly deleteAll: () => TaskEither<DBError, void>;
}
```

### 3. Validation Types

```typescript
interface ValidationSchema<T> {
  readonly validate: (data: unknown) => Either<string, T>;
  readonly schema: z.ZodSchema<T>;
}

type Validator<T> = (data: unknown) => Either<string, T>;
```

## Type Layers

### 1. API Layer

```mermaid
graph TD
    A[API Schema] --> B[Validation]
    B --> C[Conversion]
    C --> D[Domain Model]

    subgraph API Types
        E[Request]
        F[Response]
        G[Params]
        H[Query]

        E --> F
        G --> H
    end
```

### 2. Domain Layer

```mermaid
graph TD
    A[Domain Model] --> B[Value Objects]
    A --> C[Entities]
    A --> D[Aggregates]

    subgraph Domain Types
        E[Branded IDs]
        F[Business Rules]
        G[Events]
        H[Commands]

        E --> F
        F --> G
        G --> H
    end
```

### 3. Infrastructure Layer

```mermaid
graph TD
    A[Database Model] --> B[ORM Types]
    A --> C[JSON Types]
    A --> D[Migrations]

    subgraph Infrastructure
        E[Schema]
        F[Indices]
        G[Relations]
        H[Constraints]

        E --> F
        F --> G
        G --> H
    end
```

## Type Safety

### 1. Validation Chain

```mermaid
graph LR
    A[Raw Data] -->|Schema| B[Validated]
    B -->|Convert| C[Domain]
    C -->|Map| D[Database]
    D -->|Transform| E[Response]
```

### 2. Error Handling

```mermaid
graph TD
    A[Operation] --> B{Valid?}
    B -->|Yes| C[Success]
    B -->|No| D[Error]

    subgraph Error Types
        E[Validation]
        F[Domain]
        G[Technical]

        E --> F
        F --> G
    end
```

## Type Conversion

### 1. Data Flow

```mermaid
graph LR
    A[snake_case] -->|API| B[Response]
    B -->|Convert| C[camelCase]
    C -->|Store| D[Database]
```

### 2. Type Guards

```typescript
interface TypeGuard<T> {
  (value: unknown): value is T;
}

interface TypeConverter<From, To> {
  (value: From): To;
}
```

## Best Practices

### 1. Type Definition

- Use branded types for identifiers
- Define explicit validation schemas
- Implement type converters
- Maintain immutability

### 2. Type Safety

- Runtime validation with zod
- Compile-time checks
- Type guards for narrowing
- Error type hierarchies

### 3. Type Organization

```plaintext
src/types/
├── base.type.ts         # Core type system
├── errors.type.ts       # Error hierarchy
├── {domain}.type.ts     # Domain types
└── validation.type.ts   # Validation utilities
```

## Future Considerations

### 1. Type Evolution

```mermaid
graph TD
    A[Current] --> B[Migration]
    B --> C[Validation]
    C --> D[Conversion]

    subgraph Evolution
        E[Schema]
        F[Types]
        G[Models]

        E --> F
        F --> G
    end
```

### 2. Type Extensions

- Generic type builders
- Type composition utilities
- Advanced type guards
- Custom type decorators
