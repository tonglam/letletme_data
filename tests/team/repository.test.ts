import { PrismaClient, Team as PrismaTeam } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createTeamRepository } from '../../src/domain/team/repository';
import { DBError, DBErrorCode } from '../../src/types/error.type';
import { PrismaTeamCreate, TeamId, TeamRepository, TeamResponse } from '../../src/types/team.type';
import bootstrapData from '../data/bootstrap.json';

describe('Team Repository Tests', () => {
  let prisma: PrismaClient;
  let repository: TeamRepository;
  let testTeams: TeamResponse[];

  beforeAll(() => {
    prisma = new PrismaClient();
    repository = createTeamRepository(prisma);
    testTeams = bootstrapData.teams;
  });

  beforeEach(async () => {
    await prisma.team.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Basic CRUD Operations', () => {
    it('should save and retrieve a team', async () => {
      const testTeam = testTeams[0];
      const prismaTeam: PrismaTeamCreate = {
        id: testTeam.id,
        code: testTeam.code,
        name: testTeam.name,
        shortName: testTeam.short_name,
        strength: testTeam.strength,
        strengthOverallHome: testTeam.strength_overall_home,
        strengthOverallAway: testTeam.strength_overall_away,
        strengthAttackHome: testTeam.strength_attack_home,
        strengthAttackAway: testTeam.strength_attack_away,
        strengthDefenceHome: testTeam.strength_defence_home,
        strengthDefenceAway: testTeam.strength_defence_away,
        pulseId: testTeam.pulse_id,
        played: testTeam.played,
        position: testTeam.position,
        points: testTeam.points,
        form: testTeam.form,
        win: testTeam.win,
        draw: testTeam.draw,
        loss: testTeam.loss,
        teamDivision: testTeam.team_division,
        unavailable: testTeam.unavailable,
      };

      const result = await pipe(
        repository.save(prismaTeam),
        TE.fold(
          (error: DBError) => T.of(E.left(error)),
          (team: PrismaTeam) => T.of(E.right(team)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const savedTeam = result.right;
        expect(savedTeam.id).toBe(testTeam.id);
        expect(savedTeam.name).toBe(testTeam.name);
        expect(savedTeam.shortName).toBe(testTeam.short_name);
      }
    });

    it('should find all teams', async () => {
      const testTeamsData = testTeams.slice(0, 3).map((team) => ({
        id: team.id,
        code: team.code,
        name: team.name,
        shortName: team.short_name,
        strength: team.strength,
        strengthOverallHome: team.strength_overall_home,
        strengthOverallAway: team.strength_overall_away,
        strengthAttackHome: team.strength_attack_home,
        strengthAttackAway: team.strength_attack_away,
        strengthDefenceHome: team.strength_defence_home,
        strengthDefenceAway: team.strength_defence_away,
        pulseId: team.pulse_id,
        played: team.played,
        position: team.position,
        points: team.points,
        form: team.form,
        win: team.win,
        draw: team.draw,
        loss: team.loss,
        teamDivision: team.team_division,
        unavailable: team.unavailable,
      }));

      await prisma.team.createMany({ data: testTeamsData });

      const result = await pipe(
        repository.findAll(),
        TE.fold(
          (error: DBError) => T.of(E.left(error)),
          (teams: PrismaTeam[]) => T.of(E.right(teams)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const teams = result.right;
        expect(teams).toHaveLength(testTeamsData.length);
        expect(teams[0]).toMatchObject(testTeamsData[0]);
      }
    });

    it('should find team by ID', async () => {
      const testTeam = testTeams[0];
      const prismaTeam: PrismaTeamCreate = {
        id: testTeam.id,
        code: testTeam.code,
        name: testTeam.name,
        shortName: testTeam.short_name,
        strength: testTeam.strength,
        strengthOverallHome: testTeam.strength_overall_home,
        strengthOverallAway: testTeam.strength_overall_away,
        strengthAttackHome: testTeam.strength_attack_home,
        strengthAttackAway: testTeam.strength_attack_away,
        strengthDefenceHome: testTeam.strength_defence_home,
        strengthDefenceAway: testTeam.strength_defence_away,
        pulseId: testTeam.pulse_id,
        played: testTeam.played,
        position: testTeam.position,
        points: testTeam.points,
        form: testTeam.form,
        win: testTeam.win,
        draw: testTeam.draw,
        loss: testTeam.loss,
        teamDivision: testTeam.team_division,
        unavailable: testTeam.unavailable,
      };

      await prisma.team.create({ data: prismaTeam });

      const result = await pipe(
        repository.findById(testTeam.id as TeamId),
        TE.fold(
          (error: DBError) => T.of(E.left(error)),
          (team: PrismaTeam | null) => T.of(E.right(team)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const team = result.right;
        expect(team).toBeDefined();
        expect(team?.id).toBe(testTeam.id);
        expect(team?.name).toBe(testTeam.name);
      }
    });

    it('should find teams by IDs', async () => {
      const testTeamsData = testTeams.slice(0, 3).map((team) => ({
        id: team.id,
        code: team.code,
        name: team.name,
        shortName: team.short_name,
        strength: team.strength,
        strengthOverallHome: team.strength_overall_home,
        strengthOverallAway: team.strength_overall_away,
        strengthAttackHome: team.strength_attack_home,
        strengthAttackAway: team.strength_attack_away,
        strengthDefenceHome: team.strength_defence_home,
        strengthDefenceAway: team.strength_defence_away,
        pulseId: team.pulse_id,
        played: team.played,
        position: team.position,
        points: team.points,
        form: team.form,
        win: team.win,
        draw: team.draw,
        loss: team.loss,
        teamDivision: team.team_division,
        unavailable: team.unavailable,
      }));

      await prisma.team.createMany({ data: testTeamsData });

      const ids = testTeamsData.map((team) => team.id as TeamId);
      const result = await pipe(
        repository.findByIds(ids),
        TE.fold(
          (error: DBError) => T.of(E.left(error)),
          (teams: PrismaTeam[]) => T.of(E.right(teams)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const teams = result.right;
        expect(teams).toHaveLength(ids.length);
        expect(teams.map((team) => team.id)).toEqual(expect.arrayContaining(ids));
      }
    });
  });

  describe('Batch Operations', () => {
    it('should save multiple teams in batch', async () => {
      const testTeamsData = testTeams.slice(0, 3).map((team) => ({
        id: team.id,
        code: team.code,
        name: team.name,
        shortName: team.short_name,
        strength: team.strength,
        strengthOverallHome: team.strength_overall_home,
        strengthOverallAway: team.strength_overall_away,
        strengthAttackHome: team.strength_attack_home,
        strengthAttackAway: team.strength_attack_away,
        strengthDefenceHome: team.strength_defence_home,
        strengthDefenceAway: team.strength_defence_away,
        pulseId: team.pulse_id,
        played: team.played,
        position: team.position,
        points: team.points,
        form: team.form,
        win: team.win,
        draw: team.draw,
        loss: team.loss,
        teamDivision: team.team_division,
        unavailable: team.unavailable,
      }));

      const result = await pipe(
        repository.saveBatch(testTeamsData),
        TE.fold(
          (error: DBError) => T.of(E.left(error)),
          (teams: PrismaTeam[]) => T.of(E.right(teams)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const teams = result.right;
        expect(teams).toHaveLength(testTeamsData.length);
        expect(teams[0]).toMatchObject(testTeamsData[0]);
      }
    });

    it('should delete teams by IDs', async () => {
      const testTeamsData = testTeams.slice(0, 3).map((team) => ({
        id: team.id,
        code: team.code,
        name: team.name,
        shortName: team.short_name,
        strength: team.strength,
        strengthOverallHome: team.strength_overall_home,
        strengthOverallAway: team.strength_overall_away,
        strengthAttackHome: team.strength_attack_home,
        strengthAttackAway: team.strength_attack_away,
        strengthDefenceHome: team.strength_defence_home,
        strengthDefenceAway: team.strength_defence_away,
        pulseId: team.pulse_id,
        played: team.played,
        position: team.position,
        points: team.points,
        form: team.form,
        win: team.win,
        draw: team.draw,
        loss: team.loss,
        teamDivision: team.team_division,
        unavailable: team.unavailable,
      }));

      await prisma.team.createMany({ data: testTeamsData });
      const ids = testTeamsData.map((team) => team.id as TeamId);

      await pipe(
        repository.deleteByIds(ids),
        TE.fold(
          (error: DBError) => T.of(E.left(error)),
          () => T.of(E.right(undefined)),
        ),
      )();

      const remaining = await prisma.team.findMany({
        where: { id: { in: ids } },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle real database errors gracefully', async () => {
      // Create a repository with a broken prisma client to simulate DB error
      const brokenPrisma = {
        team: {
          findUnique: () => {
            throw new Error('Database connection failed');
          },
        },
      } as unknown as PrismaClient;

      const errorRepo = createTeamRepository(brokenPrisma);
      const result = await errorRepo.findById(1 as TeamId)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DBErrorCode.QUERY_ERROR);
        expect(result.left.message).toContain('Failed to fetch team');
      }
    });

    it('should handle non-existent ID as a successful null result', async () => {
      const nonExistentId = 999999;
      const result = await repository.findById(nonExistentId as TeamId)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });

    it('should handle duplicate key errors in batch operations', async () => {
      const duplicateTeams = Array(2)
        .fill(testTeams[0])
        .map((team) => ({
          id: team.id,
          code: team.code,
          name: team.name,
          shortName: team.short_name,
          strength: team.strength,
          strengthOverallHome: team.strength_overall_home,
          strengthOverallAway: team.strength_overall_away,
          strengthAttackHome: team.strength_attack_home,
          strengthAttackAway: team.strength_attack_away,
          strengthDefenceHome: team.strength_defence_home,
          strengthDefenceAway: team.strength_defence_away,
          pulseId: team.pulse_id,
          played: team.played,
          position: team.position,
          points: team.points,
          form: team.form,
          win: team.win,
          draw: team.draw,
          loss: team.loss,
          teamDivision: team.team_division,
          unavailable: team.unavailable,
        }));

      const result = await repository.saveBatch(duplicateTeams)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
      }
    });
  });
});
