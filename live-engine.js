// ================================
// ZENITH F1 LIVE ENGINE
// Real-time via F1 SignalR + OpenF1
// ================================

const SIGNALR_HUB = "https://livetiming.formula1.com/signalr";
const OPENF1 = "https://api.openf1.org/v1";

let activeSession = "QUALIFYING";
let driversMap = {};
let timingLines = {};
let connection = null;
let sessionKey = null;

// ================================
// INIT
// ================================
window.onload = async () => {
    showLoadingState("INITIALIZING LIVE TIMING...");

    // Load SignalR client dynamically
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/microsoft-signalr/6.0.1/signalr.min.js");

    // Try F1 SignalR first, fallback to OpenF1
    const connected = await connectSignalR();
    if (!connected) {
        console.warn("SignalR failed, trying OpenF1...");
        await connectOpenF1();
    }
};

// ================================
// DYNAMIC SCRIPT LOADER
// ================================
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ================================
// UI
// ================================
function showLoadingState(msg) {
    document.getElementById("leaderboard").innerHTML = `
        <tr><td colspan="12" style="text-align:center;padding:60px;color:#444;font-family:'JetBrains Mono';letter-spacing:2px;">
            <div style="font-size:2rem;margin-bottom:15px;animation:purple-pulse 1s infinite;">⏳</div>
            ${msg}
        </td></tr>`;
}

function showError(msg) {
    document.getElementById("leaderboard").innerHTML = `
        <tr><td colspan="12" style="text-align:center;padding:60px;color:var(--f1-red);font-family:'JetBrains Mono';letter-spacing:2px;">
            <div style="font-size:2rem;margin-bottom:15px;">📡</div>
            ${msg}
        </td></tr>`;
    document.getElementById("sess-label").innerText = "NO ACTIVE SESSION";
    document.getElementById("sess-timer").innerText = "STANDBY";
}

// ================================
// F1 SIGNALR CONNECTION
// ================================
async function connectSignalR() {
    try {
        // Step 1: Negotiate with F1 SignalR
        const negRes = await fetch(`${SIGNALR_HUB}/negotiate?connectionData=[{"name":"Streaming"}]&clientProtocol=1.5`, {
            headers: { "User-Agent": "BestHTTP" }
        });

        if (!negRes.ok) throw new Error("Negotiate failed");

        const neg = await negRes.json();
        const token = encodeURIComponent(neg.ConnectionToken);

        // Step 2: Connect via WebSocket
        const wsUrl = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${token}&connectionData=[{"name":"Streaming"}]`;

        connection = new WebSocket(wsUrl);

        connection.onopen = () => {
            console.log("✅ F1 SignalR Connected!");
            showLoadingState("CONNECTED — AWAITING TIMING DATA...");

            // Subscribe to all timing feeds
            const subscribe = JSON.stringify({
                H: "Streaming",
                M: "Subscribe",
                A: [["Heartbeat", "CarData.z", "Position.z", "ExtrapolatedClock",
                     "TimingStats", "TimingAppData", "WeatherData", "TrackStatus",
                     "DriverList", "RaceControlMessages", "SessionInfo",
                     "SessionData", "LapCount", "TimingData"]],
                I: 1
            });
            connection.send(subscribe);
        };

        connection.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleSignalRMessage(msg);
            } catch(e) {}
        };

        connection.onerror = (err) => {
            console.error("SignalR error:", err);
        };

        connection.onclose = () => {
            console.warn("SignalR disconnected, reconnecting in 3s...");
            setTimeout(connectSignalR, 3000);
        };

        return true;

    } catch(err) {
        console.error("SignalR connection failed:", err.message);
        return false;
    }
}

// ================================
// HANDLE SIGNALR MESSAGES
// ================================
function handleSignalRMessage(msg) {
    if (!msg.M || !msg.M.length) return;

    msg.M.forEach(m => {
        if (m.H !== "Streaming") return;
        const topic = m.M;
        const data = m.A?.[0];

        switch(topic) {
            case "feed":
                handleFeed(data);
                break;
        }
    });
}

function handleFeed(data) {
    if (!data) return;

    // Driver list
    if (data.DriverList) {
        for (const [num, d] of Object.entries(data.DriverList)) {
            driversMap[num] = {
                number: num,
                code: d.Tla || "???",
                name: `${d.FirstName || ""} ${d.LastName || ""}`.trim(),
                teamName: d.TeamName || "—",
                teamColor: d.TeamColour ? `#${d.TeamColour}` : "#888",
                racingNumber: d.RacingNumber || num
            };
        }
    }

    // Session info
    if (data.SessionInfo) {
        const s = data.SessionInfo;
        document.getElementById("round-name").innerText = `ROUND ${s.Meeting?.Key || "—"} • ${s.StartDate?.substring(0,4) || "2026"}`;
        document.getElementById("circuit-name").innerText = s.Meeting?.Circuit?.ShortName || "—";
        document.getElementById("sess-label").innerText = s.Name || "LIVE";

        const name = (s.Name || "").toLowerCase();
        if (name.includes("qualifying")) activeSession = "QUALIFYING";
        else if (name.includes("race")) activeSession = "RACE";
        else if (name.includes("sprint")) activeSession = "SPRINT";
        else if (name.includes("practice")) activeSession = "PRACTICE";
    }

    // Timing data - THE MAIN LIVE DATA
    if (data.TimingData) {
        const lines = data.TimingData.Lines || {};
        for (const [num, t] of Object.entries(lines)) {
            if (!timingLines[num]) timingLines[num] = {};
            // Deep merge
            timingLines[num] = deepMerge(timingLines[num], t);
        }
        renderDashboard();
    }

    // Track status / flags
    if (data.TrackStatus) {
        updateTrackStatus(data.TrackStatus);
    }

    // Weather
    if (data.WeatherData) {
        updateWeather(data.WeatherData);
    }

    // Race control messages
    if (data.RaceControlMessages) {
        const msgs = data.RaceControlMessages.Messages || [];
        if (msgs.length > 0) {
            const latest = msgs[msgs.length - 1];
            updateFlag(latest);
        }
    }

    // Lap count
    if (data.LapCount) {
        const lc = data.LapCount;
        document.getElementById("sess-timer").innerText = `LAP ${lc.CurrentLap || 0} / ${lc.TotalLaps || "—"}`;
    }

    // Extrapolated clock (session remaining time)
    if (data.ExtrapolatedClock) {
        const remaining = data.ExtrapolatedClock.Remaining;
        if (remaining && activeSession !== "RACE") {
            document.getElementById("sess-timer").innerText = remaining;
        }
    }
}

// ================================
// TRACK STATUS
// ================================
function updateTrackStatus(status) {
    const strip = document.getElementById("status-strip");
    const statusMap = {
        "1": { cls: "status-green", text: "🏁 ALL CLEAR" },
        "2": { cls: "status-yellow", text: "⚠️ YELLOW FLAG" },
        "3": { cls: "status-yellow", text: "⚠️⚠️ DOUBLE YELLOW" },
        "4": { cls: "status-red", text: "⛔ SAFETY CAR" },
        "5": { cls: "status-red", text: "⛔ RED FLAG" },
        "6": { cls: "status-yellow", text: "🟡 VIRTUAL SAFETY CAR" },
        "7": { cls: "status-yellow", text: "🟡 VSC ENDING" }
    };
    const s = statusMap[String(status.Status)] || { cls: "status-green", text: "🏁 TRACK CLEAR" };
    strip.className = s.cls;
    strip.innerText = s.text;
}

// ================================
// FLAG FROM RACE CONTROL
// ================================
function updateFlag(msg) {
    const strip = document.getElementById("status-strip");
    const flag = (msg.Flag || "").toUpperCase();
    const text = (msg.Message || "").toUpperCase();

    strip.className = "";
    if (flag === "GREEN" || text.includes("GREEN")) {
        strip.classList.add("status-green");
        strip.innerText = "🏁 GREEN FLAG";
    } else if (flag.includes("DOUBLE YELLOW")) {
        strip.classList.add("status-yellow");
        strip.innerText = `⚠️⚠️ DOUBLE YELLOW — SECTOR ${msg.Sector || ""}`;
    } else if (flag === "YELLOW") {
        strip.classList.add("status-yellow");
        strip.innerText = `⚠️ YELLOW — SECTOR ${msg.Sector || ""}`;
    } else if (flag === "RED") {
        strip.classList.add("status-red");
        strip.innerText = "⛔ RED FLAG — SESSION SUSPENDED";
    } else if (flag === "CHEQUERED") {
        strip.classList.add("status-green");
        strip.innerText = "🏁 CHEQUERED FLAG";
    } else if (text.includes("SAFETY CAR") && !text.includes("VIRTUAL")) {
        strip.classList.add("status-yellow");
        strip.innerText = "🚓 SAFETY CAR";
    } else if (text.includes("VIRTUAL SAFETY CAR")) {
        strip.classList.add("status-yellow");
        strip.innerText = "🟡 VIRTUAL SAFETY CAR";
    }
}

// ================================
// WEATHER
// ================================
function updateWeather(w) {
    document.getElementById("weather-status").innerHTML = `
        <span>AIR <b style="color:#fff">${w.AirTemp || "—"}°C</b></span>
        <span>TRACK <b style="color:#fff">${w.TrackTemp || "—"}°C</b></span>
        <span style="color:${w.Rainfall === "1" ? 'var(--f1-purple)' : 'var(--f1-green)'}">
            ${w.Rainfall === "1" ? "🌧️ WET" : "☀️ DRY"}
        </span>
        <span>WIND <b style="color:#fff">${w.WindSpeed || "—"} m/s</b></span>
        <span>HUM <b style="color:#fff">${w.Humidity || "—"}%</b></span>
    `;
}

// ================================
// OPENF1 FALLBACK
// ================================
async function connectOpenF1() {
    try {
        showLoadingState("CONNECTING TO OPENF1...");

        // Get latest session
        const res = await fetch(`${OPENF1}/sessions`);
        const sessions = await res.json();

        if (!sessions || sessions.length === 0) throw new Error("No sessions");

        const now = new Date();

        // Find live or most recent session
        let session = sessions.find(s => {
            const start = new Date(s.date_start);
            const end = s.date_end ? new Date(s.date_end) : null;
            return start <= now && (!end || end >= now);
        });

        if (!session) {
            session = [...sessions].sort((a, b) =>
                new Date(b.date_start) - new Date(a.date_start)
            )[0];
        }

        sessionKey = session.session_key;

        const sName = (session.session_name || "").toLowerCase();
        if (sName.includes("qualifying")) activeSession = "QUALIFYING";
        else if (sName.includes("race")) activeSession = "RACE";
        else if (sName.includes("sprint")) activeSession = "SPRINT";
        else activeSession = "PRACTICE";

        document.getElementById("round-name").innerText = `ROUND ${session.meeting_key || "—"} • ${session.year || ""}`;
        document.getElementById("circuit-name").innerText = session.circuit_short_name || session.location || "—";
        document.getElementById("sess-label").innerText = session.session_name || "LIVE";

        console.log(`✅ OpenF1 session: ${session.session_name} | Key: ${sessionKey}`);

        await fetchOpenF1Drivers();
        await fetchOpenF1Timing();

        // Poll every second
        setInterval(fetchOpenF1Timing, 1000);
        setInterval(fetchOpenF1Weather, 15000);
        setInterval(fetchOpenF1Flags, 3000);

        fetchOpenF1Weather();
        fetchOpenF1Flags();

    } catch(err) {
        console.error("OpenF1 failed:", err);
        showError("NO LIVE SESSION AVAILABLE<br><span style='font-size:0.75rem;color:#555;margin-top:10px;display:block'>Live data streams during active F1 sessions only.</span>");
    }
}

async function fetchOpenF1Drivers() {
    const res = await fetch(`${OPENF1}/drivers?session_key=${sessionKey}`);
    const data = await res.json();
    data.forEach(d => {
        driversMap[d.driver_number] = {
            number: d.driver_number,
            code: d.name_acronym || "???",
            name: `${d.first_name || ""} ${d.last_name || ""}`.trim().toUpperCase(),
            teamName: d.team_name || "—",
            teamColor: d.team_colour ? `#${d.team_colour}` : "#888",
            iso: (d.country_code || "un").toLowerCase()
        };
    });
}

async function fetchOpenF1Timing() {
    if (!sessionKey) return;
    try {
        const [lapsRes, intRes, carRes] = await Promise.all([
            fetch(`${OPENF1}/laps?session_key=${sessionKey}`),
            fetch(`${OPENF1}/intervals?session_key=${sessionKey}`),
            fetch(`${OPENF1}/car_data?session_key=${sessionKey}&speed>=0`)
        ]);

        const laps = await lapsRes.json();
        const intervals = await intRes.json();
        const carData = await carRes.json();

        // Process laps
        const lapsByDriver = {};
        laps.forEach(l => {
            if (!lapsByDriver[l.driver_number]) lapsByDriver[l.driver_number] = [];
            lapsByDriver[l.driver_number].push(l);
        });

        // Process intervals
        const latestInterval = {};
        intervals.forEach(i => { latestInterval[i.driver_number] = i; });

        // Process car data
        const latestCar = {};
        carData.forEach(c => { latestCar[c.driver_number] = c; });

        // Build timing lines
        for (const [num, driverLaps] of Object.entries(lapsByDriver)) {
            const last = driverLaps[driverLaps.length - 1];
            const best = [...driverLaps].filter(l => l.lap_duration).sort((a, b) => a.lap_duration - b.lap_duration)[0];
            const intv = latestInterval[num] || {};
            const car = latestCar[num] || {};

            timingLines[num] = {
                Position: intv.position || 99,
                GapToLeader: intv.gap_to_leader !== undefined ? (intv.gap_to_leader === 0 ? "LEADER" : `+${Number(intv.gap_to_leader).toFixed(3)}`) : "—",
                IntervalToPositionAhead: { Value: intv.interval !== undefined ? (intv.interval === 0 ? "—" : `+${Number(intv.interval).toFixed(3)}`) : "—" },
                BestLapTime: { Value: best ? formatTime(best.lap_duration) : "—" },
                LastLapTime: { Value: last?.lap_duration ? formatTime(last.lap_duration) : "—" },
                Sectors: [
                    { Value: last?.duration_sector_1 ? last.duration_sector_1.toFixed(3) : "—" },
                    { Value: last?.duration_sector_2 ? last.duration_sector_2.toFixed(3) : "—" },
                    { Value: last?.duration_sector_3 ? last.duration_sector_3.toFixed(3) : "—" }
                ],
                CurrentSector: !last?.duration_sector_2 ? 1 : !last?.duration_sector_3 ? 2 : 3,
                InPit: !!(last?.pit_in_time && !last?.pit_out_time),
                Tyre: last?.compound?.charAt(0) || "—",
                TyreAge: last?.tyre_age_at_start || 0,
                Pits: last?.stint_number ? Math.max(0, last.stint_number - 1) : 0,
                Speed: car.speed || 0,
                DRS: car.drs >= 10,
                LapNumber: last?.lap_number || 0,
                BestLapSeconds: best?.lap_duration || 9999
            };
        }

        renderDashboard();

    } catch(err) {
        console.error("OpenF1 timing error:", err);
    }
}

async function fetchOpenF1Weather() {
    if (!sessionKey) return;
    try {
        const res = await fetch(`${OPENF1}/weather?session_key=${sessionKey}`);
        const data = await res.json();
        if (!data.length) return;
        const w = data[data.length - 1];
        updateWeather({
            AirTemp: w.air_temperature?.toFixed(1),
            TrackTemp: w.track_temperature?.toFixed(1),
            Rainfall: w.rainfall > 0 ? "1" : "0",
            WindSpeed: w.wind_speed?.toFixed(1),
            Humidity: w.humidity?.toFixed(0)
        });
    } catch(err) {}
}

async function fetchOpenF1Flags() {
    if (!sessionKey) return;
    try {
        const res = await fetch(`${OPENF1}/race_control?session_key=${sessionKey}`);
        const data = await res.json();
        if (!data.length) return;
        const flagMsgs = data.filter(d => d.flag);
        if (!flagMsgs.length) return;
        const latest = flagMsgs[flagMsgs.length - 1];
        updateFlag({ Flag: latest.flag, Message: latest.message, Sector: latest.sector });
    } catch(err) {}
}

// ================================
// RENDER DASHBOARD
// ================================
function renderDashboard() {
    const tbody = document.getElementById("leaderboard");
    const headers = document.getElementById("table-headers");
    const isRace = activeSession === "RACE" || activeSession === "SPRINT";

    headers.innerHTML = `
        <th>POS</th>
        <th>DRIVER</th>
        <th>TEAM</th>
        <th>${isRace ? "GAP" : "Δ AHEAD"}</th>
        <th>BEST LAP</th>
        <th>LAST LAP</th>
        <th>S1</th><th>S2</th><th>S3</th>
        <th>TYRE</th>
        ${isRace ? "<th>PITS</th>" : ""}
        <th>SPEED</th>
        <th>STATUS</th>
    `;

    const tyreColors = { "S": "#ff1e1e", "M": "#f9d71c", "H": "#ffffff", "I": "#39b54a", "W": "#0067ff" };

    // Sort by position
    const sorted = Object.entries(timingLines)
        .map(([num, t]) => ({ num, t, driver: driversMap[num] || { code: `#${num}`, name: "", teamName: "—", teamColor: "#444", iso: "un" } }))
        .sort((a, b) => (a.t.Position || 99) - (b.t.Position || 99));

    if (sorted.length === 0) {
        showLoadingState("WAITING FOR TIMING DATA...");
        return;
    }

    // Find fastest lap for purple
    const fastest = sorted.filter(x => x.t.BestLapSeconds < 9999).sort((a, b) => a.t.BestLapSeconds - b.t.BestLapSeconds)[0];

    tbody.innerHTML = sorted.map(({ num, t, driver }, i) => {
        const isFirst = i === 0;
        const isFastest = fastest && num === fastest.num;
        const isRZ15 = activeSession === "QUALIFYING" && i >= 15;
        const isRZ10 = activeSession === "QUALIFYING" && i >= 10 && i < 15;
        const tyreColor = tyreColors[t.Tyre] || "#888";

        let rowBg = isRZ15 ? "background:#1a0000;" : isRZ10 ? "background:#150a00;" : isFirst ? "background:rgba(0,255,136,0.03);" : isFastest ? "background:rgba(183,0,255,0.05);" : "";
        const posColor = isFirst ? "var(--f1-green)" : i < 3 ? "#fff" : "#555";

        const s1 = t.Sectors?.[0]?.Value || "—";
        const s2 = t.Sectors?.[1]?.Value || "—";
        const s3 = t.Sectors?.[2]?.Value || "—";
        const curSec = t.CurrentSector || 0;

        const sectorStyle = (sec) => curSec === sec ? "color:var(--f1-purple);" : "color:#555;";

        return `
        <tr style="${rowBg}">
            <td style="font-weight:900;color:${posColor};font-size:1.1rem;">${i + 1}</td>

            <td>
                <div style="display:flex;align-items:center;gap:8px;border-left:3px solid ${driver.teamColor};padding-left:10px;">
                    ${driver.iso ? `<span class="fi fi-${driver.iso}" style="font-size:1rem;"></span>` : ""}
                    <div>
                        <div style="font-weight:900;color:${isFastest ? 'var(--f1-purple)' : '#fff'};font-size:0.95rem;">
                            ${driver.code}
                            ${t.DRS ? `<span style="background:#00ff88;color:#000;font-size:0.5rem;padding:1px 4px;border-radius:2px;font-weight:900;margin-left:3px;">DRS</span>` : ""}
                            ${isFastest ? `<span style="background:var(--f1-purple);color:#fff;font-size:0.5rem;padding:1px 5px;border-radius:2px;margin-left:3px;">FL</span>` : ""}
                        </div>
                        <div style="font-size:0.6rem;color:#555;">${driver.name}</div>
                    </div>
                </div>
            </td>

            <td style="font-size:0.7rem;color:${driver.teamColor};font-weight:900;">${driver.teamName}</td>

            <td class="time-cell" style="color:${isFirst ? 'var(--f1-green)' : '#888'};">
                ${isRace ? (t.GapToLeader || "—") : (t.IntervalToPositionAhead?.Value || "—")}
            </td>

            <td class="time-cell" style="color:${isFastest ? 'var(--f1-purple)' : '#fff'};font-weight:${isFastest ? '900' : '700'};">
                ${t.BestLapTime?.Value || "—"}
            </td>

            <td class="time-cell" style="color:#777;">${t.LastLapTime?.Value || "—"}</td>

            <td class="time-cell" style="${sectorStyle(1)}">
                ${curSec === 1 ? `<span class="purple-blink">${s1}</span>` : s1}
            </td>
            <td class="time-cell" style="${sectorStyle(2)}">
                ${curSec === 2 ? `<span class="purple-blink">${s2}</span>` : s2}
            </td>
            <td class="time-cell" style="${sectorStyle(3)}">
                ${curSec === 3 ? `<span class="purple-blink">${s3}</span>` : s3}
            </td>

            <td>
                <span style="color:${tyreColor};font-weight:900;">◉ ${t.Tyre || "—"}</span>
                <div style="color:#444;font-size:0.6rem;">${t.TyreAge ? t.TyreAge + "L" : ""}</div>
            </td>

            ${isRace ? `<td style="color:#888;font-weight:900;text-align:center;">${t.Pits ?? "—"}</td>` : ""}

            <td class="time-cell" style="color:#aaa;">
                ${t.Speed ? t.Speed + `<span style="color:#444;font-size:0.6rem;"> km/h</span>` : "—"}
            </td>

            <td>
                <span style="color:${t.InPit ? 'var(--f1-yellow)' : 'var(--f1-green)'};font-weight:900;font-size:0.75rem;">
                    ${t.InPit ? "🔧 PIT" : "● LIVE"}
                </span>
            </td>
        </tr>`;
    }).join("");
}

// ================================
// TAB SWITCHING
// ================================
function setSession(s) {
    activeSession = s;
    document.getElementById('tab-qual')?.classList.toggle('active', s === 'QUALIFYING');
    document.getElementById('tab-race')?.classList.toggle('active', s === 'RACE');
    renderDashboard();
}

// ================================
// HELPERS
// ================================
function formatTime(t) {
    if (!t) return "—";
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(3);
    return `${m}:${parseFloat(s) < 10 ? "0" + s : s}`;
}

function deepMerge(target, source) {
    if (!source) return target;
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

function updateTimer() {}
