const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('.')); // Serve HTML files

// Serve index.html explicitly at root (and as a fallback for non-API routes)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback for SPA routes (don't interfere with API or health routes)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint for Render or other PaaS
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// Helper: parse response JSON or extract window.Dto from HTML fallback
async function parseBody(response) {
  // read text once to avoid `body used already` errors
  const text = await response.text();
  // try JSON parse first
  try {
    return JSON.parse(text);
  } catch (jsonErr) {
    const match = text.match(/window\.Dto\s*=\s*({[\s\S]*?});/);
    if (match) {
      return JSON.parse(match[1]);
    }
    throw new Error('Could not parse response as JSON or extract window.Dto');
  }
}

app.get('/api/matches', async (req, res) => {
  try {
    console.log('Received request for /api/matches with query:', req.query);
    const { gradeId, teamId } = req.query;
    if (!gradeId) {
      return res.status(400).json({ error: 'Missing gradeId parameter' });
    }
    const url = `https://grassrootsapiproxy.cricket.com.au/scores/grades/${gradeId}/matches?jsconfig=eccn%3Atrue`;
    console.log('Fetching data from:', url);
    const response = await fetch(url);
    const data = await parseBody(response);
    let matches = data.matches || [];
    if (teamId) {
      // Filter for matches for this team (any status)
      const teamMatches = matches.filter(m => m.teams.some(t => t.id === teamId));
      if (teamMatches.length === 0) {
        return res.json({ matches: [] });
      }
      // Prefer matches that are not UPCOMING; fall back to any match if none
      const nonUpcoming = teamMatches.filter(m => m.status !== 'UPCOMING');
      const candidateMatches = nonUpcoming.length ? nonUpcoming : teamMatches;
      const getScheduleStart = m => (m.matchSchedule && m.matchSchedule[0] && m.matchSchedule[0].startDateTime) || null;
      candidateMatches.sort((a, b) => {
        const tA = getScheduleStart(a) ? Date.parse(getScheduleStart(a)) : -Infinity;
        const tB = getScheduleStart(b) ? Date.parse(getScheduleStart(b)) : -Infinity;
        return tB - tA; // descending
      });

      // Take the selected match and fetch the latest detailed match data (includeScorecard)
      const chosen = candidateMatches[0];

      // 3) Look up the detailed scorecard and attach it under `detail`
      try {
        const detailUrl = `https://grassrootsapiproxy.cricket.com.au/scores/matches/${chosen.id}?responseModifier=includeScorecard&jsconfig=eccn%3Atrue`;
        console.log('Fetching match detail from:', detailUrl);
        const detailRes = await fetch(detailUrl);
        let detailData = await parseBody(detailRes);
        if (detailData && detailData.matches && Array.isArray(detailData.matches) && detailData.matches.length) {
          detailData = detailData.matches[0];
        }
        if (detailData && detailData.match) {
          detailData = detailData.match;
        }
        chosen.detail = detailData;
      } catch (e) {
        console.warn('Could not fetch match detail:', e.message || e);
        chosen.detail = null;
      }

      // 4) Look up the list of balls from the match
      let lastBall = null;
      try {
        const ballsUrl = `https://grassrootsapiproxy.cricket.com.au/scores/matches/${chosen.id}/balls?jsconfig=eccn%3Atrue`;
        console.log('Fetching balls from:', ballsUrl);
        const ballsRes = await fetch(ballsUrl);
        const ballsBody = await parseBody(ballsRes);

        // 5) Find the last innings
        let inningsArray = [];
        if (Array.isArray(ballsBody)) {
          // Could be an array of innings (each with balls) or just an array of balls
          if (ballsBody.length && ballsBody[0] && ballsBody[0].balls) {
            inningsArray = ballsBody; // innings array
          } else {
            // treat as single innings containing these balls
            inningsArray = [{ balls: ballsBody }];
          }
        } else if (ballsBody && Array.isArray(ballsBody.innings)) {
          inningsArray = ballsBody.innings;
        } else if (ballsBody && Array.isArray(ballsBody.balls)) {
          inningsArray = [{ balls: ballsBody.balls }];
        }

        // 6) Find the last ball of the innings
        if (inningsArray.length) {
          const lastInnings = inningsArray[inningsArray.length - 1];
          const inningsBalls = Array.isArray(lastInnings.balls) ? lastInnings.balls : [];
          if (inningsBalls.length) {
            lastBall = inningsBalls[inningsBalls.length - 1];
          }
        }

        // 6b) fallback: if still no lastBall, try alt endpoint without jsconfig
        if (!lastBall) {
          try {
            const altUrl = `https://grassrootsapiproxy.cricket.com.au/scores/matches/${chosen.id}/balls`;
            console.log('Retrying balls fetch with alt URL:', altUrl);
            const altRes = await fetch(altUrl);
            const altBody = await parseBody(altRes);
            let altInnings = [];
            if (Array.isArray(altBody)) {
              if (altBody.length && altBody[0] && altBody[0].balls) altInnings = altBody;
              else altInnings = [{ balls: altBody }];
            } else if (altBody && Array.isArray(altBody.innings)) {
              altInnings = altBody.innings;
            } else if (altBody && Array.isArray(altBody.balls)) {
              altInnings = [{ balls: altBody.balls }];
            }
            if (altInnings.length) {
              const li = altInnings[altInnings.length - 1];
              const ib = Array.isArray(li.balls) ? li.balls : [];
              if (ib.length) lastBall = ib[ib.length - 1];
            }
          } catch (e) {
            console.warn('Alt balls fetch failed:', e.message || e);
          }
        }
      } catch (e) {
        console.warn('Could not fetch balls or parse them:', e.message || e);
      }

      // 7) Attach the last ball
      if (lastBall) {
        chosen.lastBall = lastBall;
        // 8) Put the currently participating players under currentPlayers
        chosen.currentPlayers = {
          strikerId: lastBall.strikerParticipantId || null,
          strikerName: lastBall.strikerShortName || lastBall.striker || null,
          nonStrikerId: lastBall.nonStrikerParticipantId || null,
          nonStrikerName: lastBall.nonStrikerShortName || lastBall.nonStriker || null,
          bowlerId: lastBall.bowlerParticipantId || null,
          bowlerName: lastBall.bowlerShortName || lastBall.bowler || null
        };

        // Add batting stats for striker/non-striker from the detailed scorecard if available
        try {
          const detail = chosen.detail;
          if (detail && Array.isArray(detail.innings) && detail.innings.length) {
            const lastInningsDetail = detail.innings[detail.innings.length - 1];
            const battingList = Array.isArray(lastInningsDetail.batting) ? lastInningsDetail.batting : [];
            const findBat = (participantId) => {
              return battingList.find(b => b.participantId === participantId || b.participant && b.participant.id === participantId) || null;
            };

            const strikerBat = findBat(chosen.currentPlayers.strikerId);
            if (strikerBat) {
              chosen.currentPlayers.strikerRuns = strikerBat.runsScored ?? strikerBat.runs ?? null;
              chosen.currentPlayers.strikerBalls = strikerBat.ballsFaced ?? strikerBat.balls ?? null;
            } else {
              chosen.currentPlayers.strikerRuns = null;
              chosen.currentPlayers.strikerBalls = null;
            }

            const nonStrikerBat = findBat(chosen.currentPlayers.nonStrikerId);
            if (nonStrikerBat) {
              chosen.currentPlayers.nonStrikerRuns = nonStrikerBat.runsScored ?? nonStrikerBat.runs ?? null;
              chosen.currentPlayers.nonStrikerBalls = nonStrikerBat.ballsFaced ?? nonStrikerBat.balls ?? null;
            } else {
              chosen.currentPlayers.nonStrikerRuns = null;
              chosen.currentPlayers.nonStrikerBalls = null;
            }

            // For bowler, try to find batting stats if they are also batting in this innings
            const bowlerBat = findBat(chosen.currentPlayers.bowlerId);
            if (bowlerBat) {
              chosen.currentPlayers.bowlerRuns = bowlerBat.runsScored ?? bowlerBat.runs ?? null;
              chosen.currentPlayers.bowlerBalls = bowlerBat.ballsFaced ?? bowlerBat.balls ?? null;
            } else {
              chosen.currentPlayers.bowlerRuns = null;
              chosen.currentPlayers.bowlerBalls = null;
            }

            // Also extract bowling figures for the current bowler from the innings bowling list
            try {
              const bowlingList = Array.isArray(lastInningsDetail.bowling) ? lastInningsDetail.bowling : [];
              const findBowl = (participantId) => {
                return bowlingList.find(b => b.participantId === participantId || (b.participant && b.participant.id === participantId)) || null;
              };
              const bowlerStats = findBowl(chosen.currentPlayers.bowlerId);
              if (bowlerStats) {
                // sensible cricket bowling figures: overs, maidens, runs, wickets, econ, noBalls, wides
                chosen.currentPlayers.bowlerOvers = bowlerStats.oversBowled ?? bowlerStats.overs ?? null;
                chosen.currentPlayers.bowlerMaidens = bowlerStats.maidensBowled ?? bowlerStats.maidens ?? null;
                chosen.currentPlayers.bowlerRunsConceded = bowlerStats.runsConceded ?? bowlerStats.runs ?? null;
                chosen.currentPlayers.bowlerWickets = bowlerStats.wicketsTaken ?? bowlerStats.wickets ?? null;
                chosen.currentPlayers.bowlerNoBalls = bowlerStats.noBalls ?? bowlerStats.noBalls ?? 0;
                chosen.currentPlayers.bowlerWides = bowlerStats.wideBalls ?? bowlerStats.wides ?? 0;
                chosen.currentPlayers.bowlerEconomy = bowlerStats.economy ?? null;
                chosen.currentPlayers.isBowling = bowlerStats.isBowling ?? null;
              } else {
                chosen.currentPlayers.bowlerOvers = null;
                chosen.currentPlayers.bowlerMaidens = null;
                chosen.currentPlayers.bowlerRunsConceded = null;
                chosen.currentPlayers.bowlerWickets = null;
                chosen.currentPlayers.bowlerNoBalls = null;
                chosen.currentPlayers.bowlerWides = null;
                chosen.currentPlayers.bowlerEconomy = null;
                chosen.currentPlayers.isBowling = null;
              }
            } catch (e) {
              console.warn('Could not attach bowling stats from detail:', e.message || e);
            }
          }
        } catch (e) {
          console.warn('Could not attach batting stats from detail:', e.message || e);
        }
      } else {
        chosen.lastBall = null;
        chosen.currentPlayers = null;
      }

      return res.json({ matches: [chosen] });
    }
    res.json({ matches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT} (PORT=${PORT})`);
});