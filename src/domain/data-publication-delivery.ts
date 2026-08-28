/**
 * Pure delivery error classification. The Redis pointer is monotonic: a
 * newer pointer means the claimed publication can never be retried safely,
 * while every other failure remains recoverable through the outbox lease.
 */
export type DataPublicationDeliveryFailureDisposition = 'retry' | 'superseded';

export function classifyDataPublicationDeliveryFailure(
  error: unknown,
): DataPublicationDeliveryFailureDisposition {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Redis publication is newer') ? 'superseded' : 'retry';
}
