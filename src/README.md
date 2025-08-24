# Simplified Architecture

## Overview

This is a simplified, direct approach for the FPL data synchronization service. Gone are the complex DDD layers, fp-ts functional programming overhead, and complex dependency injection. This new architecture focuses on **simplicity, readability, and maintainability**.

## Architecture

```
src/
├── api/           # Service functions & HTTP endpoints
├── jobs/          # Cron job definitions  
├── clients/       # External API clients (FPL)
├── transformers/  # Data transformation functions
├── repositories/  # Database operations (Drizzle)
├── cache/         # Redis cache operations
├── db/            # Database schema & config
├── types/         # TypeScript type definitions
└── utils/         # Helper functions (logger, errors)
```

## Key Principles

### 1. **Direct & Simple**
- **No complex abstractions** - Functions do what they say
- **async/await** instead of TaskEither monads
- **Simple error handling** with try/catch
- **Flat module structure** - easy to navigate

### 2. **Still Type-Safe**
- **TypeScript** for compile-time safety
- **Zod schemas** for runtime validation
- **Strong typing** throughout the data flow

### 3. **Robust & Performant**
- **PostgreSQL** with Drizzle ORM
- **Redis caching** with fallback strategies
- **Structured logging** with Pino
- **Proper error handling** and monitoring

## Data Flow

```
FPL API → Client → Transformer → Repository → Database
                                      ↓
                              Cache Operations → Redis
```

### Example: Events Sync

```typescript
export async function syncEvents(): Promise<void> {
  try {
    // 1. Fetch from FPL API
    const bootstrapData = await fplClient.getBootstrap();
    
    // 2. Transform to domain events
    const events = transformEvents(bootstrapData.events);
    
    // 3. Save to database
    await eventRepository.upsertBatch(events);
    
    // 4. Update cache
    await eventsCache.set(events);
    
    logInfo('Events sync completed', { count: events.length });
  } catch (error) {
    logError('Events sync failed', error);
    throw error;
  }
}
```

## API Endpoints

### Events
- `GET /events` - Get all events
- `GET /events/current` - Get current event
- `GET /events/next` - Get next event  
- `GET /events/:id` - Get specific event
- `POST /events/sync` - Manually trigger sync
- `DELETE /events/cache` - Clear cache

### Jobs
- `POST /jobs/events/trigger` - Manually trigger events job

## Background Jobs

### Events Sync Job
- **Schedule**: Daily at 6:30 AM UTC
- **Function**: Sync all events from FPL API
- **Error Handling**: Logged but doesn't stop future runs

## Benefits vs Old Architecture

| Old (DDD/FP) | New (Simplified) |
|---------------|------------------|
| 4+ abstraction layers | 2-3 direct layers |
| TaskEither monads | async/await |
| Complex DI tree | Direct imports |
| Branded domain types | Simple TypeScript types |
| fp-ts overhead | Native JavaScript/TypeScript |
| Hard to debug | Clear stack traces |
| Slow development | Fast iteration |
| Over-engineered | Right-sized for the task |

## Getting Started

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Setup environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your database and Redis configs
   ```

3. **Run migrations**:
   ```bash
   bun run db:migrate
   ```

4. **Start development**:
   ```bash
   bun run dev
   ```

5. **Test the API**:
   ```bash
   curl http://localhost:3000/events
   curl -X POST http://localhost:3000/events/sync
   ```

## Adding New Services

To add a new service (e.g., teams):

1. **Create transformer**: `src/transformers/teams.ts`
2. **Create repository**: `src/repositories/teams.ts` 
3. **Create API service**: `src/api/teams.ts`
4. **Create job** (if needed): `src/jobs/teams.ts`
5. **Add routes** to `src/index.ts`

Simple, direct, and maintainable! 🚀
