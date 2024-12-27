/**
 * Creates domain operations utilities for converting between domain and persistence models
 */
export const createDomainOperations = <D, P>({
  toDomain,
  toPrisma,
}: {
  toDomain: (data: P) => D;
  toPrisma: (data: D) => Omit<P, 'createdAt'>;
}) => ({
  single: {
    toDomain: (data: P | null): D | null => (data ? toDomain(data) : null),
    fromDomain: toPrisma,
  },
  array: {
    toDomain: (data: readonly P[]): readonly D[] => data.map(toDomain),
    fromDomain: (data: readonly D[]): Omit<P, 'createdAt'>[] => Array.from(data.map(toPrisma)),
  },
});

/**
 * Returns the value if it's defined, otherwise returns undefined
 * Useful for handling optional updates in repositories
 * @param value - The value to check
 * @returns The value if defined, undefined otherwise
 */
export const getDefinedValue = <T>(value: T | undefined): T | undefined =>
  value !== undefined ? value : undefined;
