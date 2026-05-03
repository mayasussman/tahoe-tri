// ── STRAVA API CLIENT ─────────────────────────────────────────────────────────
// Handles OAuth 2.0, token refresh, activity fetching, and plan matching.
//
// Setup (one-time):
//   1. Go to https://www.strava.com/settings/api
//   2. Create an app — set "Authorization Callback Domain" to localhost
//   3. Enter your Client ID and Client Secret in the app's Strava settings panel
//   4. Serve this folder via HTTP: python3 -m http.server 8080
//   5. Open http://localhost:8080 and click "Connect Strava"

class StravaClient {
  static BASE  = 'https://www.strava.com/api/v3';
  static AUTH  = 'https://www.strava.com/oauth/authorize';
  static TOKEN = 'https://www.strava.com/oauth/token';

  // Map Strava sport_type → plan workout type
  static TYPE_MAP = {
    Swim:             'swim',
    OpenWaterSwim:    'ows',
    Ride:             'bike',
    MountainBikeRide: 'bike',
    EBikeRide:        'bike',
    GravelRide:       'bike',
    VirtualRide:      'bike',
    Run:              'run',
    TrailRun:         'run',
    Hike:             'run',
    Walk:             'run',
    WeightTraining:   'strength',
    Workout:          'strength',
    CrossTraining:    'strength',
    Brick:            'brick',
    Triathlon:        'race',
  };

  // ── Config & token storage (localStorage) ──────────────────────────────────

  getConfig() { return JSON.parse(localStorage.getItem('strava-cfg') || '{}'); }
  setConfig(c) { localStorage.setItem('strava-cfg', JSON.stringify(c)); }

  getToken()   { return JSON.parse(localStorage.getItem('strava-token') || 'null'); }
  setToken(t)  {
    if (t) localStorage.setItem('strava-token', JSON.stringify(t));
    else   localStorage.removeItem('strava-token');
  }

  getCachedActivities()  { return JSON.parse(localStorage.getItem('strava-activities') || 'null'); }
  setCachedActivities(a) { localStorage.setItem('strava-activities', JSON.stringify({ts: Date.now(), data: a})); }

  isConfigured() {
    const c = this.getConfig();
    return !!(c.clientId && c.clientSecret);
  }

  isConnected() {
    const t = this.getToken();
    return !!(t && t.access_token);
  }

  getAthleteInfo() {
    const t = this.getToken();
    return t ? { name: t.athlete?.firstname, avatar: t.athlete?.profile_medium } : null;
  }

  // ── OAuth flow ─────────────────────────────────────────────────────────────

  getRedirectUri() {
    return window.location.origin + window.location.pathname;
  }

  startAuth() {
    const { clientId } = this.getConfig();
    if (!clientId) throw new Error('Client ID not set');
    const uri = this.getRedirectUri();
    window.location.href =
      `${StravaClient.AUTH}?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&response_type=code` +
      `&scope=activity:read_all` +
      `&approval_prompt=auto`;
  }

  // Call on page load — returns true if a code was in the URL and was exchanged
  async handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code  = params.get('code');
    const error = params.get('error');

    if (error) {
      // Clean up URL
      history.replaceState({}, '', window.location.pathname);
      throw new Error('Strava authorization denied');
    }
    if (!code) return false;

    // Clean up URL before async work
    history.replaceState({}, '', window.location.pathname);

    const { clientId, clientSecret } = this.getConfig();
    const res = await fetch(StravaClient.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const token = await res.json();
    if (!token.access_token) throw new Error(token.message || 'Token exchange failed');
    this.setToken(token);
    return true;
  }

  // ── Token management ───────────────────────────────────────────────────────

  async ensureValidToken() {
    let token = this.getToken();
    if (!token) return null;

    const expired = token.expires_at && (Date.now() / 1000) > (token.expires_at - 300);
    if (!expired) return token;

    const { clientId, clientSecret } = this.getConfig();
    const res = await fetch(StravaClient.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const newToken = await res.json();
    if (!newToken.access_token) { this.setToken(null); return null; }
    this.setToken(newToken);
    return newToken;
  }

  disconnect() {
    this.setToken(null);
    localStorage.removeItem('strava-activities');
  }

  // ── Activity fetching ──────────────────────────────────────────────────────

  async fetchActivities(after, { forceRefresh = false } = {}) {
    // Return cached data if fresh (< 15 min old) and not forced
    if (!forceRefresh) {
      const cached = this.getCachedActivities();
      if (cached && Date.now() - cached.ts < 15 * 60 * 1000) return cached.data;
    }

    const token = await this.ensureValidToken();
    if (!token) return null;

    const afterTs = Math.floor(after.getTime() / 1000);
    const activities = [];
    let page = 1;

    while (true) {
      const res = await fetch(
        `${StravaClient.BASE}/athlete/activities?after=${afterTs}&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${token.access_token}` } }
      );

      if (res.status === 401) { this.setToken(null); return null; }
      if (!res.ok) break;

      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      activities.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    this.setCachedActivities(activities);
    return activities;
  }

  // ── Plan matching ──────────────────────────────────────────────────────────
  // Returns { woId: { stravaId, sportType, name, distance, movingTime, elevation, startDate } }

  matchToPlan(activities, plan) {
    if (!activities) return {};

    const DAY_OFFSET = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };
    const matches = {};

    for (const act of activities) {
      const actDate  = new Date(act.start_date_local);
      const woType   = StravaClient.TYPE_MAP[act.sport_type] || StravaClient.TYPE_MAP[act.type];
      if (!woType) continue;

      for (const phase of plan) {
        for (const week of phase.weeks) {
          const [y, m, d] = week.start.split('-').map(Number);

          for (const day of week.days) {
            const planDate = new Date(y, m - 1, d + (DAY_OFFSET[day.day] ?? 0));
            if (actDate.toDateString() !== planDate.toDateString()) continue;

            for (const slot of day.slots) {
              for (const wo of slot.workouts) {
                if (wo.rest || wo.type !== woType) continue;
                if (matches[wo.id]) continue; // first match wins

                matches[wo.id] = {
                  stravaId:  act.id,
                  sportType: act.sport_type,
                  name:      act.name,
                  distance:  act.distance,       // meters
                  movingTime: act.moving_time,   // seconds
                  elevation: act.total_elevation_gain, // meters
                  startDate: act.start_date_local,
                };
              }
            }
          }
        }
      }
    }

    return matches;
  }

  // ── Formatting helpers ─────────────────────────────────────────────────────

  static fmtDist(meters, type) {
    if (!meters) return '';
    const isSwim = type === 'swim' || type === 'ows';
    if (isSwim) {
      return meters >= 1000
        ? `${(meters / 1000).toFixed(2)} km`
        : `${Math.round(meters)} m`;
    }
    const miles = meters / 1609.34;
    return `${miles.toFixed(1)} mi`;
  }

  static fmtTime(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  static fmtElev(meters) {
    if (!meters || meters < 5) return '';
    return `↑ ${Math.round(meters * 3.28084)} ft`;
  }

  static activityUrl(id) {
    return `https://www.strava.com/activities/${id}`;
  }
}

const strava = new StravaClient();
