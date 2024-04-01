const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';
const FPL_CHALLENGE_BASE_URL = 'https://fplchallenge.premierleague.com/api';
const FPL_RESOURCE_URL = 'https://resources.premierleague.com';

const fpl_api_config = {
  BOOTSTRAP_STATIC_URL: `${FPL_BASE_URL}/bootstrap-static/`,
  GW_BOOTSTRAP_URL: (event: number): string => `${FPL_BASE_URL}/bootstrap-static/${event}`,
  GW_FIXTURE_URL: (event: number): string => `${FPL_BASE_URL}/fixtures/?event=${event}`,
  ELEMENT_SUMMARY_URL: (element: number) => `${FPL_BASE_URL}/element-summary/${element}/`,
  ELEMENT_PHOTO_URL: (photo_id: number) =>
    `${FPL_RESOURCE_URL}/premierleague/photos/players/110x140/p${photo_id}.png`,
  EVENT_LIVE_URL: (event: number) => `${FPL_BASE_URL}/event/${event}/live/`,
  ENTRY_URL: (entry: number): string => `${FPL_BASE_URL}/entry/${entry}/`,
  ENTRY_HISTORY_URL: (entry: number): string => `${FPL_BASE_URL}/entry/${entry}/history/`,
  ENTRY_EVENT_PICKS_URL: (entry: number, event: number): string =>
    `${FPL_BASE_URL}/entry/${entry}/event/${event}/picks/`,
  ENTRY_EVENT_TRANSFERS_URL: (entry: number): string => `${FPL_BASE_URL}/entry/${entry}/transfers/`,
  LEAGUE_CLASSIC_URL: (league_id: number, page: number): string =>
    `${FPL_BASE_URL}/leagues-classic/${league_id}/standings/?page_standings=${page}`,
  LEAGUE_H2H_URL: (league_id: number, page: number): string =>
    `${FPL_BASE_URL}/leagues-h2h/${league_id}/standings/?page_standings=${page}`,
};

const challenge_api_config = {
  BOOTSTRAP_STATIC_URL: `${FPL_CHALLENGE_BASE_URL}/bootstrap-static/`,
  GW_BOOTSTRAP_URL: (event: number): string =>
    `${FPL_CHALLENGE_BASE_URL}/bootstrap-static/${event}`,
  GW_FIXTURE_URL: (event: number): string => `${FPL_CHALLENGE_BASE_URL}/fixtures/?event=${event}`,
  ENTRY_URL: (entry: number, event: number, phase: number): string =>
    `${FPL_CHALLENGE_BASE_URL}/entry/${entry}/?event=${event}&phase=${phase}`,
  ENTRY_EVENT_PICKS_URL: (entry: number, event: number): string =>
    `${FPL_CHALLENGE_BASE_URL}/entry/${entry}/event/${event}/picks/`,
  ENTRY_EVENT_TRANSFERS_URL: (entry: number): string =>
    `${FPL_CHALLENGE_BASE_URL}/entry/${entry}/transfers/`,
  LEAGUE_URL: (league_id: number, page: number, phase: number): string =>
    `${FPL_CHALLENGE_BASE_URL}/leagues-classic/${league_id}/standings/?page_standings=${page}&phase=${phase}`,
};

export { challenge_api_config, fpl_api_config };
