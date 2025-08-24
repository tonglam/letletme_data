import { z } from 'zod';

import type { Phase, RawFPLPhase } from '../types';

// ================================
// Domain Validation Schemas
// ================================

export const PhaseSchema = z.object({
  id: z.number().int().positive('Phase ID must be a positive integer'),
  name: z.string().min(1, 'Phase name is required').max(50, 'Phase name too long'),
  startEvent: z
    .number()
    .int()
    .min(1, 'Start event must be at least 1')
    .max(38, 'Start event cannot exceed 38'),
  stopEvent: z
    .number()
    .int()
    .min(1, 'Stop event must be at least 1')
    .max(38, 'Stop event cannot exceed 38'),
  highestScore: z.number().int().min(0, 'Highest score cannot be negative').nullable(),
});

export const RawFPLPhaseSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  start_event: z.number().int().min(1).max(38),
  stop_event: z.number().int().min(1).max(38),
  highest_score: z.number().int().min(0).nullable(),
});

// ================================
// Domain Business Logic
// ================================

/**
 * Check if a phase is the overall season phase
 */
export function isOverallPhase(phase: Phase): boolean {
  return phase.name.toLowerCase() === 'overall';
}

/**
 * Check if a phase is a monthly phase
 */
export function isMonthlyPhase(phase: Phase): boolean {
  const monthNames = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  return monthNames.includes(phase.name.toLowerCase());
}

/**
 * Check if a phase is currently active (contains current gameweek)
 */
export function isPhaseActive(phase: Phase, currentGameweek: number): boolean {
  return currentGameweek >= phase.startEvent && currentGameweek <= phase.stopEvent;
}

/**
 * Check if a phase has finished
 */
export function isPhaseFinished(phase: Phase, currentGameweek: number): boolean {
  return currentGameweek > phase.stopEvent;
}

/**
 * Check if a phase has started
 */
export function isPhaseStarted(phase: Phase, currentGameweek: number): boolean {
  return currentGameweek >= phase.startEvent;
}

/**
 * Get the number of gameweeks in a phase
 */
export function getPhaseLength(phase: Phase): number {
  return phase.stopEvent - phase.startEvent + 1;
}

/**
 * Get phase progress as a percentage (0-100)
 */
export function getPhaseProgress(phase: Phase, currentGameweek: number): number {
  if (currentGameweek < phase.startEvent) return 0;
  if (currentGameweek > phase.stopEvent) return 100;

  const progress = ((currentGameweek - phase.startEvent + 1) / getPhaseLength(phase)) * 100;
  return Math.round(progress * 100) / 100; // Round to 2 decimal places
}

/**
 * Get remaining gameweeks in a phase
 */
export function getRemainingGameweeks(phase: Phase, currentGameweek: number): number {
  if (currentGameweek > phase.stopEvent) return 0;
  if (currentGameweek < phase.startEvent) return getPhaseLength(phase);

  return phase.stopEvent - currentGameweek;
}

/**
 * Check if a phase has a recorded highest score
 */
export function hasHighestScore(phase: Phase): boolean {
  return phase.highestScore !== null && phase.highestScore > 0;
}

/**
 * Get phase status
 */
export function getPhaseStatus(
  phase: Phase,
  currentGameweek: number,
): 'upcoming' | 'active' | 'finished' {
  if (isPhaseFinished(phase, currentGameweek)) return 'finished';
  if (isPhaseActive(phase, currentGameweek)) return 'active';
  return 'upcoming';
}

/**
 * Get phase type based on name and duration
 */
export function getPhaseType(phase: Phase): 'overall' | 'monthly' | 'custom' {
  if (isOverallPhase(phase)) return 'overall';
  if (isMonthlyPhase(phase)) return 'monthly';
  return 'custom';
}

/**
 * Validate a phase object against the domain schema
 */
export function validatePhase(phase: unknown): Phase {
  const validated = PhaseSchema.parse(phase);

  // Additional validation: start event must be <= stop event
  if (validated.startEvent > validated.stopEvent) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Start event must be less than or equal to stop event',
        path: ['startEvent', 'stopEvent'],
      },
    ]);
  }

  return validated;
}

/**
 * Validate raw FPL phase data
 */
export function validateRawFPLPhase(rawPhase: unknown): RawFPLPhase {
  const validated = RawFPLPhaseSchema.parse(rawPhase);

  // Additional validation: start event must be <= stop event
  if (validated.start_event > validated.stop_event) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Start event must be less than or equal to stop event',
        path: ['start_event', 'stop_event'],
      },
    ]);
  }

  return validated;
}

/**
 * Validate array of phases
 */
export function validatePhases(phases: unknown[]): Phase[] {
  return phases.map(validatePhase);
}

/**
 * Get phases by status
 */
export function filterPhasesByStatus(
  phases: Phase[],
  status: 'upcoming' | 'active' | 'finished',
  currentGameweek: number,
): Phase[] {
  return phases.filter((phase) => getPhaseStatus(phase, currentGameweek) === status);
}

/**
 * Get phases by type
 */
export function filterPhasesByType(
  phases: Phase[],
  type: 'overall' | 'monthly' | 'custom',
): Phase[] {
  return phases.filter((phase) => getPhaseType(phase) === type);
}

/**
 * Find phase that contains a specific gameweek
 */
export function findPhaseByGameweek(phases: Phase[], gameweek: number): Phase | null {
  return (
    phases.find((phase) => gameweek >= phase.startEvent && gameweek <= phase.stopEvent) || null
  );
}

/**
 * Get the overall season phase
 */
export function getOverallPhase(phases: Phase[]): Phase | null {
  return phases.find(isOverallPhase) || null;
}

/**
 * Get all monthly phases sorted by start event
 */
export function getMonthlyPhases(phases: Phase[]): Phase[] {
  return phases.filter(isMonthlyPhase).sort((a, b) => a.startEvent - b.startEvent);
}

/**
 * Get phases with highest scores recorded
 */
export function getPhasesWithScores(phases: Phase[]): Phase[] {
  return phases.filter(hasHighestScore);
}

/**
 * Get the highest scoring phase
 */
export function getHighestScoringPhase(phases: Phase[]): Phase | null {
  const phasesWithScores = getPhasesWithScores(phases);
  if (phasesWithScores.length === 0) return null;

  return phasesWithScores.reduce((highest, current) =>
    (current.highestScore || 0) > (highest.highestScore || 0) ? current : highest,
  );
}

/**
 * Sort phases by start event
 */
export function sortPhasesByStartEvent(phases: Phase[]): Phase[] {
  return [...phases].sort((a, b) => a.startEvent - b.startEvent);
}

/**
 * Sort phases by highest score (descending)
 */
export function sortPhasesByHighestScore(phases: Phase[]): Phase[] {
  return [...phases].sort((a, b) => (b.highestScore || 0) - (a.highestScore || 0));
}

// ================================
// Export type inference helpers
// ================================

export type ValidatedPhase = z.infer<typeof PhaseSchema>;
export type ValidatedRawFPLPhase = z.infer<typeof RawFPLPhaseSchema>;
