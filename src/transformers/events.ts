import { Event, RawFPLEvent } from '../types';

// Transform FPL API event to our domain Event
export function transformEvent(rawEvent: RawFPLEvent): Event {
  return {
    id: rawEvent.id,
    name: rawEvent.name,
    deadlineTime: rawEvent.deadline_time ? new Date(rawEvent.deadline_time) : null,
    averageEntryScore: rawEvent.average_entry_score,
    finished: rawEvent.finished,
    dataChecked: rawEvent.data_checked,
    highestScoringEntry: rawEvent.highest_scoring_entry,
    deadlineTimeEpoch: rawEvent.deadline_time_epoch,
    deadlineTimeGameOffset: rawEvent.deadline_time_game_offset,
    highestScore: rawEvent.highest_score,
    isPrevious: rawEvent.is_previous,
    isCurrent: rawEvent.is_current,
    isNext: rawEvent.is_next,
    cupLeagueCreate: rawEvent.cup_leagues_created,
    h2hKoMatchesCreated: rawEvent.h2h_ko_matches_created,
    chipPlays: rawEvent.chip_plays || [],
    mostSelected: rawEvent.most_selected,
    mostTransferredIn: rawEvent.most_transferred_in,
    topElement: rawEvent.top_element,
    topElementInfo: rawEvent.top_element_info,
    transfersMade: rawEvent.transfers_made,
    mostCaptained: rawEvent.most_captained,
    mostViceCaptained: rawEvent.most_vice_captained,
  };
}

// Transform array of events
export function transformEvents(rawEvents: RawFPLEvent[]): Event[] {
  return rawEvents.map(transformEvent);
}
