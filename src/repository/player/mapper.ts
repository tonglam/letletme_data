import { DbPlayer, DbPlayerCreateInput } from 'repository/player/types';
import { PlayerId, PlayerType, RawPlayer } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

export const mapDbPlayerToDomain = (dbPlayer: DbPlayer): RawPlayer => ({
  id: dbPlayer.id as PlayerId,
  code: dbPlayer.code,
  type: dbPlayer.type as PlayerType,
  teamId: dbPlayer.teamId as TeamId,
  price: dbPlayer.price,
  startPrice: dbPlayer.startPrice,
  firstName: dbPlayer.firstName,
  secondName: dbPlayer.secondName,
  webName: dbPlayer.webName,
});

export const mapDomainPlayerToDbCreate = (domainPlayer: RawPlayer): DbPlayerCreateInput => ({
  id: domainPlayer.id,
  code: domainPlayer.code,
  type: domainPlayer.type,
  teamId: domainPlayer.teamId,
  price: domainPlayer.price,
  startPrice: domainPlayer.startPrice,
  firstName: domainPlayer.firstName,
  secondName: domainPlayer.secondName,
  webName: domainPlayer.webName,
});
