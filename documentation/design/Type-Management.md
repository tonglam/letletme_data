This document outlines our approach to managing types in the application, ensuring type safety, validation, and clean architecture.

## Structure

Types are managed in three distinct layers:

1. **API Response Schema** (External Data)

   - Validates raw data from external APIs
   - Uses snake_case to match API conventions
   - Example: `PhaseResponseSchema`

2. **Domain Schema** (Internal Model)

   - Represents our internal domain model
   - Uses camelCase for consistency
   - Example: `PhaseSchema`

3. **Type Transformers**
   - Handles conversion between external and internal types
   - Includes validation during transformation
   - Example: `toDomainPhase`

## File Organization

```typescript
// ============ Schemas ============
// API Response Schema (snake_case)
export const PhaseResponseSchema = z.object({...});

// Domain Schema (camelCase)
export const PhaseSchema = z.object({...});

// ============ Types ============
// API Response types
export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;

// Domain types
export type Phase = z.infer<typeof PhaseSchema>;

// ============ Type Transformers ============
export const toDomainPhase = (raw: PhaseResponse): Either<string, Phase> => {...};
```

## Data Flow

1. **API Response Validation**

   ```typescript
   const validatedResponse = validateResponse(PhaseResponseSchema)(apiResponse);
   ```

2. **Domain Transformation**

   ```typescript
   const domainModel = transformRawPhase(validatedResponse.right);
   ```

3. **Business Rules Validation**
   ```typescript
   const validatedPhase = validatePhase(domainModel.right);
   ```

## Best Practices

1. **Type Safety**

   - Use Zod for runtime validation
   - Leverage TypeScript for static type checking
   - No use of `any` type

2. **Separation of Concerns**

   - Keep schemas in dedicated type files
   - Separate validation logic from business logic
   - Clear distinction between external and internal types

3. **Validation Layers**

   - API response validation (structure)
   - Domain model validation (types)
   - Business rules validation (logic)

4. **Error Handling**

   - Use `Either` type for error handling
   - Clear error messages
   - Type-safe error responses

5. **Naming Conventions**
   - Response types: `{Entity}Response`
   - Domain types: `{Entity}`
   - Schemas: `{Entity}Schema`
   - Transformers: `toDomain{Entity}`

## Example Implementation

See `src/types/phase.type.ts` for a complete example of this approach.
