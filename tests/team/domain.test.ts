import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  PrismaTeam,
  TeamId,
  TeamResponse,
  toDomainTeam,
  validateTeamId,
} from '../../src/types/team.type';
import bootstrapData from '../data/bootstrap.json';

describe('Team Domain Tests', () => {
  let testTeams: TeamResponse[];

  beforeAll(() => {
    testTeams = bootstrapData.teams;
  });

  describe('Domain Model Transformation', () => {
    it('should transform API response to domain model', () => {
      const response = testTeams[0];
      const team = toDomainTeam(response);

      expect(team).toMatchObject({
        id: expect.any(Number),
        code: expect.any(Number),
        name: expect.any(String),
        shortName: expect.any(String),
        strength: expect.any(Number),
        strengthOverallHome: expect.any(Number),
        strengthOverallAway: expect.any(Number),
        strengthAttackHome: expect.any(Number),
        strengthAttackAway: expect.any(Number),
        strengthDefenceHome: expect.any(Number),
        strengthDefenceAway: expect.any(Number),
        pulseId: expect.any(Number),
        played: expect.any(Number),
        position: expect.any(Number),
        points: expect.any(Number),
        win: expect.any(Number),
        draw: expect.any(Number),
        loss: expect.any(Number),
        unavailable: expect.any(Boolean),
      });

      // Verify field transformations
      expect(team.id).toBe(response.id);
      expect(team.code).toBe(response.code);
      expect(team.name).toBe(response.name);
      expect(team.shortName).toBe(response.short_name);
      expect(team.strength).toBe(response.strength);
      expect(team.strengthOverallHome).toBe(response.strength_overall_home);
      expect(team.strengthOverallAway).toBe(response.strength_overall_away);
      expect(team.strengthAttackHome).toBe(response.strength_attack_home);
      expect(team.strengthAttackAway).toBe(response.strength_attack_away);
      expect(team.strengthDefenceHome).toBe(response.strength_defence_home);
      expect(team.strengthDefenceAway).toBe(response.strength_defence_away);
      expect(team.pulseId).toBe(response.pulse_id);
      expect(team.played).toBe(response.played);
      expect(team.position).toBe(response.position);
      expect(team.points).toBe(response.points);
      expect(team.win).toBe(response.win);
      expect(team.draw).toBe(response.draw);
      expect(team.loss).toBe(response.loss);
      expect(team.teamDivision).toBe(response.team_division);
      expect(team.unavailable).toBe(response.unavailable);
    });

    it('should transform Prisma model to domain model', () => {
      const apiTeam = testTeams[0];
      const prismaTeam: PrismaTeam = {
        id: apiTeam.id,
        code: apiTeam.code,
        name: apiTeam.name,
        shortName: apiTeam.short_name,
        strength: apiTeam.strength,
        strengthOverallHome: apiTeam.strength_overall_home,
        strengthOverallAway: apiTeam.strength_overall_away,
        strengthAttackHome: apiTeam.strength_attack_home,
        strengthAttackAway: apiTeam.strength_attack_away,
        strengthDefenceHome: apiTeam.strength_defence_home,
        strengthDefenceAway: apiTeam.strength_defence_away,
        pulseId: apiTeam.pulse_id,
        played: apiTeam.played,
        position: apiTeam.position,
        points: apiTeam.points,
        form: apiTeam.form,
        win: apiTeam.win,
        draw: apiTeam.draw,
        loss: apiTeam.loss,
        teamDivision: apiTeam.team_division,
        unavailable: apiTeam.unavailable,
        createdAt: new Date(),
      };
      const team = toDomainTeam(prismaTeam);

      expect(team).toMatchObject({
        id: prismaTeam.id,
        code: prismaTeam.code,
        name: prismaTeam.name,
        shortName: prismaTeam.shortName,
        strength: prismaTeam.strength,
        strengthOverallHome: prismaTeam.strengthOverallHome,
        strengthOverallAway: prismaTeam.strengthOverallAway,
        strengthAttackHome: prismaTeam.strengthAttackHome,
        strengthAttackAway: prismaTeam.strengthAttackAway,
        strengthDefenceHome: prismaTeam.strengthDefenceHome,
        strengthDefenceAway: prismaTeam.strengthDefenceAway,
        pulseId: prismaTeam.pulseId,
        played: prismaTeam.played,
        position: prismaTeam.position,
        points: prismaTeam.points,
        win: prismaTeam.win,
        draw: prismaTeam.draw,
        loss: prismaTeam.loss,
        teamDivision: prismaTeam.teamDivision,
        unavailable: prismaTeam.unavailable,
      });
    });

    it('should handle optional and null fields correctly', () => {
      // Test with null form
      const responseWithNull: TeamResponse = {
        ...testTeams[0],
        form: null,
        team_division: null,
      };
      const teamWithNull = toDomainTeam(responseWithNull);
      expect(teamWithNull.form).toBeNull();
      expect(teamWithNull.teamDivision).toBeNull();

      // Test with missing optional fields
      const responseWithMissing: TeamResponse = {
        ...testTeams[0],
        form: null,
        team_division: null,
      };
      const teamWithMissing = toDomainTeam(responseWithMissing);
      expect(teamWithMissing.form).toBeNull();
      expect(teamWithMissing.teamDivision).toBeNull();
    });
  });

  describe('Team ID Validation', () => {
    it('should validate valid team ID', () => {
      const result = validateTeamId(testTeams[0].id);
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((id) => {
          expect(id).toBe(testTeams[0].id);
          expect(typeof id).toBe('number');
        }),
      );
    });

    it('should reject invalid team ID types', () => {
      const testCases = [
        { input: 'invalid' },
        { input: null },
        { input: undefined },
        { input: {} },
        { input: [] },
      ];

      testCases.forEach(({ input }) => {
        const result = validateTeamId(input as number);
        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left).toContain('Invalid team ID');
        }
      });
    });

    it('should reject invalid numeric values', () => {
      const testCases = [
        { input: 0 },
        { input: -1 },
        { input: 1.5 },
        { input: Infinity },
        { input: NaN },
      ];

      testCases.forEach(({ input }) => {
        const result = validateTeamId(input);
        expect(E.isLeft(result)).toBe(true);
        if (E.isLeft(result)) {
          expect(result.left).toContain('Invalid team ID');
        }
      });
    });

    it('should create branded type for valid ID', () => {
      const validIds = testTeams.map((p) => p.id);

      validIds.forEach((id) => {
        const result = validateTeamId(id);
        pipe(
          result,
          E.map((validId) => {
            const typedId: TeamId = validId;
            expect(typedId).toBe(id);
          }),
        );
      });
    });
  });

  describe('Team Aggregates', () => {
    it('should validate team relationships', () => {
      const teams = testTeams.map((team) => toDomainTeam(team)).sort((a, b) => a.id - b.id);

      // Verify sequential IDs
      teams.forEach((team, index) => {
        expect(team.id).toBe(testTeams[index].id);
      });

      // Verify team data consistency
      teams.forEach((team) => {
        expect(team.points).toBe(team.win * 3 + team.draw);
        expect(team.played).toBe(team.win + team.draw + team.loss);
      });
    });
  });
});
