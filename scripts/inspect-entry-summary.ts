const entryId = Number(process.argv[2] || '15702');
const url = `https://fantasy.premierleague.com/api/entry/${entryId}/`;

async function main() {
  const res = await fetch(url);
  if (!res.ok) {
    console.error('HTTP error', res.status, res.statusText);
    process.exit(1);
  }
  const json: any = await res.json();
  const pick = (k: string) => ({ key: k, value: json[k], type: typeof json[k] });
  const keys = [
    'id',
    'name',
    'player_first_name',
    'player_last_name',
    'player_region_id',
    'player_region_name',
    'joined_time',
    'started_event',
    'current_event',
    'summary_overall_points',
    'summary_overall_rank',
    'summary_event_points',
    'summary_event_rank',
    'favourite_team',
    'last_deadline_bank',
    'last_deadline_value',
    'last_deadline_total_transfers',
    'last_deadline_total_points',
    'last_deadline_rank',
  ];
  const out = keys.map(pick);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error('Failed to inspect entry summary', e);
  process.exit(1);
});
