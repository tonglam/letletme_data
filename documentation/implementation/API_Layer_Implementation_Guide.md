# API Layer Implementation Guide

## Overview

This guide demonstrates how to implement API endpoints following functional programming principles using fp-ts and zod for type safety. We'll use the Events API as a reference implementation.

## Directory Structure

```plaintext
src/api/
├── routes/
│   └── events/
│       ├── index.ts        # Route configuration
│       ├── handlers.ts     # Request handlers
│       └── validation.ts   # Request validation
├── middleware/
│   ├── error.ts           # Error handling middleware
│   └── validation.ts      # Validation middleware
└── types.ts               # Shared API types
```

## Core Components

### 1. Route Types

```typescript
// API response types
interface APIResponse<T> {
  status: 'success';
  data: T;
}

interface APIErrorResponse {
  status: 'error';
  error: {
    code: string;
    message: string;
  };
}

// Request validation schemas
const EventIdParams = z.object({
  params: z.object({
    id: z.string().transform((val) => Number(val)),
  }),
});

type EventIdParamsType = z.infer<typeof EventIdParams>;
```

### 2. Route Implementation

```typescript
export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));
  router.get('/current', createHandler(handlers.getCurrentEvent));
  router.get('/next', createHandler(handlers.getNextEvent));
  router.get('/:id', validateRequest(EventIdParams), createHandler(handlers.getEventById));

  return router;
};
```

### 3. Handler Implementation

```typescript
const createEventHandlers = (eventService: EventService) => ({
  getAllEvents: () =>
    pipe(
      eventService.getEvents(),
      TE.map((events) => ({ status: 'success', data: events })),
    ),

  getCurrentEvent: () =>
    pipe(
      eventService.getCurrentEvent(),
      TE.map((event) => ({ status: 'success', data: event })),
    ),

  getEventById: (req: Request) =>
    pipe(
      validateEventId(Number(req.params.id)),
      TE.fromEither,
      TE.chain((id) => eventService.getEvent(id)),
      TE.map((event) => ({ status: 'success', data: event })),
    ),
});
```

### 4. Error Handling

```typescript
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ValidationError) {
    return res.status(400).json({
      status: 'error',
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message,
      },
    });
  }

  if (err instanceof ServiceError) {
    return res.status(503).json({
      status: 'error',
      error: {
        code: 'SERVICE_ERROR',
        message: err.message,
      },
    });
  }

  return res.status(500).json({
    status: 'error',
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
};
```

## Implementation Steps

1. **Define Route Types**

```typescript
// Request validation
const EventQuerySchema = z.object({
  query: z.object({
    season: z.string().optional(),
  }),
});

// Response types
type EventResponse = APIResponse<Event>;
type EventsResponse = APIResponse<readonly Event[]>;
```

2. **Create Request Handlers**

```typescript
const getEventById = (req: Request) =>
  pipe(
    validateEventId(Number(req.params.id)),
    TE.fromEither,
    TE.chain((id) => eventService.getEvent(id)),
    TE.map((event) =>
      event ? successResponse(event) : errorResponse('NOT_FOUND', 'Event not found'),
    ),
  );
```

3. **Configure Routes**

```typescript
const router = Router();

router.get('/', validateRequest(EventQuerySchema), createHandler(handlers.getAllEvents));
router.get('/current', createHandler(handlers.getCurrentEvent));
```

4. **Add Error Handling**

```typescript
router.use(errorHandler);
```

## Best Practices

### 1. Type Safety

- Use zod for request validation
- Define explicit response types
- Use branded types for IDs
- Handle nulls explicitly

### 2. Error Handling

```typescript
const handleServiceError = (error: ServiceError): APIErrorResponse => ({
  status: 'error',
  error: {
    code: error.code,
    message: error.message,
  },
});
```

### 3. Response Formatting

```typescript
const successResponse = <T>(data: T): APIResponse<T> => ({
  status: 'success',
  data,
});

const errorResponse = (code: string, message: string): APIErrorResponse => ({
  status: 'error',
  error: { code, message },
});
```

### 4. Middleware

```typescript
const validateRequest =
  (schema: z.Schema) => (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req);
    if (!result.success) {
      next(new ValidationError(result.error.message));
      return;
    }
    next();
  };
```

## Testing

### 1. Route Tests

```typescript
describe('GET /events', () => {
  it('should return all events', async () => {
    const response = await request(app).get('/events');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});
```

### 2. Error Tests

```typescript
describe('GET /events/:id', () => {
  it('should handle invalid ID format', async () => {
    const response = await request(app).get('/events/invalid');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
```

## Common Patterns

### 1. Request Validation

```typescript
const validateEventId = (value: unknown): E.Either<string, EventId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid event ID',
    ),
    E.map((v) => v as EventId),
  );
```

### 2. Response Transformation

```typescript
const mapToResponse = <T>(data: T) =>
  pipe(
    data,
    TE.right,
    TE.map((d) => ({ status: 'success', data: d })),
  );
```

### 3. Error Mapping

```typescript
const mapError = (error: unknown): APIErrorResponse => {
  if (error instanceof ValidationError) {
    return {
      status: 'error',
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message,
      },
    };
  }
  return {
    status: 'error',
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  };
};
```
