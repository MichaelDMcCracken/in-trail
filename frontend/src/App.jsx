import { useState, useEffect, useRef, useMemo } from 'react'
import { ARTCC_NAMES, TRACON_NAMES, FACILITY_NAMES, CONTROL_FACILITY_NAMES } from './facilityNames'

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtTime(iso) {
    if (!iso) return null
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }) + 'Z'
}

function fmtRelative(iso) {
    if (!iso) return null
    const diff = new Date(iso) - Date.now()
    const abs = Math.abs(diff)
    const mins = Math.floor(abs / 60000)
    const hrs = Math.floor(mins / 60)
    const m = mins % 60
    if (diff < 0) return hrs > 0 ? `-${hrs}h${m}m` : `-${mins}m`
    return hrs > 0 ? `+${hrs}h${m}m` : `+${mins}m`
}

function fmtRemaining(iso) {
    if (!iso) return null
    const diff = new Date(iso) - Date.now()
    const mins = Math.max(0, Math.floor(Math.abs(diff) / 60000))
    const hrs = Math.floor(mins / 60)
    const remainingMins = mins % 60
    if (mins >= 24 * 60) {
        const days = Math.floor(mins / (24 * 60))
        const months = Math.floor(days / 30)
        const remainingDays = days % 30
        if (months > 0) return `${months} mo${months === 1 ? '' : 's'}${remainingDays ? ` ${remainingDays} day${remainingDays === 1 ? '' : 's'}` : ''} remaining`
        return `${days} day${days === 1 ? '' : 's'} remaining`
    }
    if (hrs > 0) return `${hrs} hr${hrs === 1 ? '' : 's'} ${remainingMins} min remaining`
    return `${remainingMins} min remaining`
}

function fmtEndTime(iso) {
    if (!iso) return null
    const diff = new Date(iso) - Date.now()
    if (diff < 24 * 60 * 60 * 1000) return fmtTime(iso)
    const date = new Date(iso)
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: '2-digit' }) + ` · ${fmtTime(iso)}`
}

// ── Type groupings ───────────────────────────────────────────────────────────

const GROUPS = [
    {
        key: 'stop',
        label: 'Ground Stops & Route Closures',
        icon: '🛑',
        color: 'red',
        matches: tmi => ['STOP', 'GS'].includes(tmi.type),
    },
    {
        key: 'gdp',
        label: 'Ground Delay Programs',
        icon: '⏱',
        color: 'orange',
        types: ['GDP'],
    },
    {
        key: 'trail',
        label: 'In-Trail Restrictions',
        icon: '↔',
        color: 'yellow',
        types: ['MINIT', 'MIT'],
    },
    {
        key: 'edct',
        label: 'EDCTs',
        icon: '🕐',
        color: 'purple',
        types: ['EDCT'],
    },
    {
        key: 'reroute',
        label: 'Reroutes',
        icon: '↩',
        color: 'teal',
        types: ['REROUTE'],
    },
    {
        key: 'other',
        label: 'Other Restrictions',
        icon: '≋',
        color: 'blue',
        types: ['FLOW'],
    },
]

const GROUP_STYLES = {
    red:    { header: 'bg-red-950 border-red-800',    badge: 'bg-red-500 text-white',    row: 'border-red-900/40' },
    orange: { header: 'bg-orange-950 border-orange-800', badge: 'bg-orange-500 text-white', row: 'border-orange-900/40' },
    yellow: { header: 'bg-yellow-950 border-yellow-800', badge: 'bg-yellow-400 text-black', row: 'border-yellow-900/40' },
    blue:   { header: 'bg-blue-950 border-blue-800',  badge: 'bg-blue-500 text-white',   row: 'border-blue-900/40' },
    purple: { header: 'bg-purple-950 border-purple-800', badge: 'bg-purple-500 text-white', row: 'border-purple-900/40' },
    teal:   { header: 'bg-teal-950 border-teal-800',  badge: 'bg-teal-500 text-white',   row: 'border-teal-900/40' },
}

const DISPLAYED_RESTRICTION_TYPES = new Set(['STOP', 'MIT', 'MINIT'])

// ── Plain-English description ────────────────────────────────────────────────

function facilityCodes(facility) {
    return facility
        .replace(/(?:Â£|£)/g, '|')
    .split(/[|/]/)
    .map(segment => segment.trim())
        .filter(segment => segment && !/^\d+$/.test(segment))
}

function formatFacility(facility, compact = false) {
    const codes = facilityCodes(facility)
    if (compact && codes.length > 4) {
        const traconCount = codes.filter(code => TRACON_NAMES[code]).length
        const artccCount = codes.filter(code => ARTCC_NAMES[code]).length
        if (artccCount === codes.length) return `${codes.length} ARTCCs`
        if (traconCount + artccCount === codes.length) return `${codes.length} facilities`
    }
    return codes
        .map(code => FACILITY_NAMES[code] ? `${FACILITY_NAMES[code]} (${code})` : code)
        .join(' / ')
}

function formatRoute(route) {
    return route
        .split('/')
        .map(value => value.replace(/\*/g, '').trim())
        .filter(Boolean)
        .join(' / ')
}

function describe(tmi) {
    if (tmi.source === 'FAA_RESTRICTIONS') return tmi.plainLanguage || tmi.name
    const isGroundStop = ['STOP', 'GS'].includes(tmi.type)
    const from = tmi.providingFacility ? `from ${formatFacility(tmi.providingFacility, isGroundStop)}` : ''
    const rawTarget = tmi.type === 'MIT' && !tmi.milesInTrail && !tmi.minutesInTrail && tmi.name
        ? tmi.name.replace(/\s+\d+\s*(?:MIT|MINIT)\s*$/i, '').trim()
        : tmi.controlledElement || tmi.nasElement || tmi.aerodrome
    const target = rawTarget.includes('/') ? formatRoute(rawTarget) : rawTarget.replace(/\*/g, '')
    const flow = tmi.restriction ? tmi.restriction.toLowerCase() : 'traffic'
    const reason = tmi.reason ? ` ${summarizeTmiReason(tmi.reason)}.` : ''

    switch (tmi.type) {
        case 'STOP':
        case 'GS':
            return `Ground stop on ${flow} to ${target} ${from}.${reason}`
        case 'GDP':
            return `Ground delay program into ${target} ${from}`
        case 'MINIT':
            return `${tmi.minutesInTrail}-minute in-trail at ${target}${tmi.milesInTrail ? ` (${tmi.milesInTrail} nm)` : ''} for ${flow} ${from}.${reason}`
        case 'MIT':
            return `${tmi.milesInTrail}-mile in-trail at ${target} for ${flow} ${from}.${reason}`
        case 'APREQ':
            return `Approval required for ${flow} to ${target} ${from}`
        case 'EDCT':
            return `Expect departure clearance time for ${flow} to ${target} ${from}`
        case 'REROUTE':
            return `Reroute affecting ${target} ${from}`
        default:
            return `${tmi.type} on ${target} ${from}`
    }
}

function summarizeTmiReason(reason) {
    const value = reason.replace(/\s+/g, ' ').trim()
    const weatherMatch = value.match(/^WX\s*:\s*(.+)$/i) || value.match(/^WX\s+(.+)$/i)
    if (weatherMatch) return `Due to ${weatherMatch[1].toLowerCase()}`
    const volumeMatch = value.match(/^VOL\s*:\s*(.+)$/i) || value.match(/^VOL\s+(.+)$/i)
    if (volumeMatch) return `Due to volume: ${volumeMatch[1].replace(/[-_]+/g, ' ').toLowerCase()}`
    const reasonMatch = value.match(/^REASON\s+(.+)$/i)
    if (reasonMatch) return `Due to ${reasonMatch[1].toLowerCase()}`
    return `Due to ${value.replace(/[-_]+/g, ' ').toLowerCase()}`
}

const COMMON_DESCRIPTION_WORDS = new Set([
    'A', 'ACTIVE', 'AIRBORNE', 'AN', 'APPROVAL', 'ARRIVALS', 'AS', 'AT', 'BEHIND',
    'BECAUSE', 'BY', 'CLOSED', 'CLOSURE', 'CLEARANCE', 'DEPARTURES', 'EAST', 'EFFECT',
    'EXCEPT', 'FLOW', 'FOR', 'FROM', 'GROUND', 'IN', 'INTO', 'JET', 'JETS', 'MILE',
    'LTFC', 'MILES', 'MINUTE', 'MINUTES', 'NORTH', 'OF', 'ON', 'ONE', 'PER', 'PROGRAM', 'REQUIRED',
    'ROUTE', 'SCHEDULE', 'SCHEDULING', 'SOUTH', 'SPEED', 'STOP', 'THE', 'TO', 'TRAFFIC',
    'OTHER', 'RALT', 'VIA', 'WEST', 'WITH', 'VOLUME',
])

const AVIATION_TERM_LABELS = {
    RRTE: 'Reroute',
}

function locationLabel(code) {
    return CONTROL_FACILITY_NAMES[code]
    ? <span className="center-label"><strong>{CONTROL_FACILITY_NAMES[code]}</strong><small>{code}</small></span>
        : code.replace(/^K/, '')
}

function highlightAviationTerms(text) {
    return text.split(/([A-Z][A-Z0-9]{1,7})/g).map((part, index) => {
        const isRoute = /^[A-Z]{1,3}\d{1,4}$/.test(part)
        const centerName = CONTROL_FACILITY_NAMES[part]
        const isNamedFacility = FACILITY_NAMES[part]
        const isAirportOrFix = /^[A-Z]{3,5}$/.test(part)
            && !COMMON_DESCRIPTION_WORDS.has(part)
        const isIdentifier = isRoute || isAirportOrFix || isNamedFacility
        const label = AVIATION_TERM_LABELS[part]
        if (centerName) {
            return <strong
                className="center-term"
                key={`${part}-${index}`}
                title={centerName}
                data-tooltip={centerName}
                tabIndex="0"
                aria-label={`${part}, ${centerName}`}
            >{part}</strong>
        }
        return isIdentifier
            ? label
                ? label
                : <strong className="aviation-term" key={`${part}-${index}`}>{part}</strong>
            : part
    })
}

// ── TMI Row ──────────────────────────────────────────────────────────────────

function TMIRow({ tmi, style }) {
    const isProposed = tmi.status === 'PROPOSED'
    const hasTime = tmi.untilFurtherNotice || tmi.startTime || tmi.endTime

    return (
        <div className={`restriction-row border-b last:border-b-0 ${style.row}`}>
            {/* Status pill */}
            <div className="restriction-status">
                {isProposed
                    ? <span className="status-pill status-pill--proposed">PROPOSED</span>
                    : <span className="status-pill status-pill--active">{tmi.status || 'ACTIVE'}</span>
                }
            </div>

            {/* Airport tag */}
            <span className="airport-code">{locationLabel(tmi.aerodrome)}</span>

            {/* Description */}
            <span className="row-description">{highlightAviationTerms(describe(tmi))}</span>

            {/* Time */}
            {hasTime && (
                <TimeBubble tmi={tmi} />
            )}

            {/* Reason chip */}
                {tmi.reason && !['STOP', 'GS', 'MIT', 'MINIT'].includes(tmi.type) && (
                <span className="reason-chip">
                    {tmi.reason}
                </span>
            )}
        </div>
    )
}

function TimeBubble({ tmi }) {
    return (
        <span className="time-bubble">
            {tmi.untilFurtherNotice
                ? <span className="time-bubble__ufn">UNTIL FURTHER NOTICE</span>
                : <>
                    {tmi.startTime && <span><small>START</small><strong>{fmtTime(tmi.startTime)}</strong></span>}
                    {tmi.endTime && <span><small>END</small><strong>{fmtEndTime(tmi.endTime)}</strong></span>}
                    {tmi.endTime && <em>{fmtRemaining(tmi.endTime)}</em>}
                </>
            }
        </span>
    )
}

function summarizeDelayReason(reason) {
    const value = (reason || '').trim()
    if (!value) return 'reason not posted'
    if (/^TM Initiatives:(?:SWAP|MIT):WX$/i.test(value)) return 'Due to weather'
    const weatherMatch = value.match(/^WX:(.+)$/i)
    if (weatherMatch) return `Due to ${weatherMatch[1].trim().toLowerCase()}`
    if (/^RWY:CONSTRUCTION$/i.test(value)) return 'Due to runway construction'
    return `Due to ${value.replace(/^TM Initiatives:/i, '').trim().toLowerCase()}`
}

function AirportOperations({ operations, autoExpand, query }) {
    const [collapsed, setCollapsed] = useState(true)

    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    if (!operations) return null
    const matchesAirport = item => !query || item.airport.includes(query) || item.aerodrome.includes(query)
    const groundStops = operations.groundStops.filter(matchesAirport)
    const groundDelayPrograms = operations.groundDelayPrograms.filter(matchesAirport)
    const departureDelays = operations.departureDelays.filter(matchesAirport)
    const hasData = groundStops.length > 0 || groundDelayPrograms.length > 0 || departureDelays.length > 0
    if (!hasData) return null

    return (
        <section className="group-card airport-operations-card">
            <button className="group-card__header airport-operations-card__header" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title"><span className="group-card__icon">◉</span><span>Airport operations</span></h2>
                <span className="airport-operations-card__meta">FAA NAS status · posted live data</span>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="airport-operations">
                <div className="airport-operations__grid">
                {groundStops.length > 0 && (
                    <div className="airport-operations__group airport-operations__group--stop">
                        <h3>Arrival ground stops <strong>{groundStops.length}</strong></h3>
                        {groundStops.map(item => (
                            <div className="airport-operation" key={`stop-${item.airport}`}>
                                <strong>{item.airport}</strong><span>{item.reason}</span><em>until {item.endTime}</em>
                            </div>
                        ))}
                    </div>
                )}
                {groundDelayPrograms.length > 0 && (
                    <div className="airport-operations__group airport-operations__group--gdp">
                        <h3>Ground delay programs <strong>{groundDelayPrograms.length}</strong></h3>
                        {groundDelayPrograms.map(item => (
                            <div className="airport-operation" key={`gdp-${item.airport}`}>
                                <strong>{item.airport}</strong><span>{summarizeDelayReason(item.reason)}{item.comments ? ` · ${item.comments}` : ''}</span>
                                <div className="airport-operation__metrics"><span className="airport-operation__metric--average">avg {item.averageDelay}</span><span className="airport-operation__metric--maximum">max {item.maximumDelay}</span></div>
                            </div>
                        ))}
                    </div>
                )}
                {departureDelays.length > 0 && (
                    <div className="airport-operations__group airport-operations__group--departure">
                        <h3>Posted departure delays <strong>{departureDelays.length}</strong></h3>
                        {departureDelays.map(item => (
                            <div className="airport-operation" key={`departure-${item.airport}`}>
                                <strong>{item.airport}</strong><span>{summarizeDelayReason(item.reason)}</span>
                                <div className="airport-operation__metrics"><span className="airport-operation__metric--range">{item.minimumDelay} to {item.maximumDelay}</span><em className={`airport-operation__metric--trend airport-operation__metric--trend-${item.trend.toLowerCase()}`}>{item.trend}</em></div>
                            </div>
                        ))}
                    </div>
                )}
                </div>
            </div>}
        </section>
    )
}

// ── Group Card ───────────────────────────────────────────────────────────────

function GroupCard({ group, tmis, autoExpand }) {
    const [collapsed, setCollapsed] = useState(true)
    const style = GROUP_STYLES[group.color]
    const active = tmis.filter(t => t.status === 'ACTIVE')
    const proposed = tmis.filter(t => t.status === 'PROPOSED')
    // Sort: active first, then by aerodrome
    const sorted = [
        ...active.sort((a, b) => a.aerodrome.localeCompare(b.aerodrome)),
        ...proposed.sort((a, b) => a.aerodrome.localeCompare(b.aerodrome)),
    ]

    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    return (
        <section className={`group-card ${group.color}`}>
            <button className={`group-card__header ${style.header}`} type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title">
                    <span className="group-card__icon">{group.icon}</span>
                    <span>{group.label}</span>
                </h2>
                <div className="group-card__counts">
                    {active.length > 0 && (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${style.badge}`}>
                            {active.length} active
                        </span>
                    )}
                    {proposed.length > 0 && (
                        <span className="text-xs font-bold px-2 py-0.5 rounded bg-yellow-400 text-black">
                            {proposed.length} proposed
                        </span>
                    )}
                </div>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="group-card__body">
                {sorted.map(tmi => (
                    <TMIRow key={tmi.id} tmi={tmi} style={style} />
                ))}
            </div>}
        </section>
    )
}

// ── Runway Closure Row ───────────────────────────────────────────────────────

function ClosureRow({ aerodrome, closures }) {
    return closures.map(c => (
        <div key={c.id} className="restriction-row closure-row">
            <span className={`status-pill ${c.state === 'ACTIVATED' ? 'status-pill--red' : 'status-pill--yellow'}`}>
                {c.state}
            </span>
            <span className="airport-code">{locationLabel(aerodrome)}</span>
            <span className="row-description">
                {c.source === 'OPS_PLAN'
                    ? <>{highlightAviationTerms(c.name)}</>
                    : c.runways.length > 0
                    ? <>Runway{c.runways.length > 1 ? 's' : ''} <strong className="text-white">{c.runways.join(' / ')}</strong> closed</>
                    : <><strong className="text-white">Airport</strong> closed</>
                }
                {c.source !== 'OPS_PLAN' && c.name && c.name !== 'Airport closed' ? ` — ${c.name.trim()}` : ''}
            </span>
            <TimeBubble tmi={c} />
        </div>
    ))
}

function OperationsPlan({ plan, autoExpand }) {
    const [collapsed, setCollapsed] = useState(true)
    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    if (!plan) return null

    return (
        <section className="group-card ops-plan-card">
            <button className="group-card__header ops-plan-card__header" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title">
                    <span className="group-card__icon">◎</span><span>Operations Plan</span>
                </h2>
                <span className="ops-plan-card__meta">{plan.sections.length} sections</span>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="ops-plan-body">
                <div className="ops-plan-title">{plan.title}</div>
                {Object.keys(plan.airportImpacts || {}).length > 0 && (
                    <div className="airport-impacts">
                        <div className="airport-impacts__heading">
                            <h3>Airport Impacts</h3>
                            <span>{Object.keys(plan.airportImpacts).length} airports</span>
                        </div>
                        {Object.entries(plan.airportImpacts).map(([airport, impacts]) => (
                            <section className="airport-impact" key={airport}>
                                <div className="airport-impact__airport">
                                    <strong>{airport}</strong>
                                    <span>{impacts.length} impact{impacts.length === 1 ? '' : 's'}</span>
                                </div>
                                <div className="airport-impact__items">
                                    {impacts.map(impact => (
                                        <div className="airport-impact__item" key={impact.id}>
                                            <span className={`impact-status impact-status--${impact.status.toLowerCase()}`}>{impact.status}</span>
                                            <span className="impact-kind">{impact.kind}</span>
                                            <span className="airport-impact__description">{highlightAviationTerms(impact.plainLanguage)}</span>
                                            {impact.endTime && <span className="airport-impact__end">Until {fmtTime(impact.endTime)}</span>}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
                {plan.sections.map(section => (
                    <section className="ops-plan-section" key={section.heading}>
                        <h3>{section.heading}</h3>
                        <div className="ops-plan-lines">
                            {section.lines.map((line, index) => <p key={`${section.heading}-${index}`}>{highlightAviationTerms(line)}</p>)}
                        </div>
                    </section>
                ))}
            </div>}
        </section>
    )
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
    const [connected, setConnected] = useState(false)
    const [lastUpdated, setLastUpdated] = useState(null)
    const [restrictions, setRestrictions] = useState([])
    const [runwayClosures, setRunwayClosures] = useState({})
    const [opsPlan, setOpsPlan] = useState(null)
    const [airportOperations, setAirportOperations] = useState(null)
    const [closuresCollapsed, setClosuresCollapsed] = useState(true)
    const [search, setSearch] = useState('')
    const wsRef = useRef(null)
    const searchRef = useRef(null)

    useEffect(() => {
        function connect() {
            const backendUrl = import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:3001`
            const wsUrl = backendUrl.replace(/^http/, 'ws')
            const ws = new WebSocket(wsUrl)
            wsRef.current = ws
            ws.onopen = () => setConnected(true)
            ws.onclose = () => {
                setConnected(false)
                setTimeout(connect, 3000)
            }
            ws.onmessage = (e) => {
                const { event, data } = JSON.parse(e.data)
                if (event === 'snapshot' || event === 'update') {
                    setConnected(data.connected)
                    setLastUpdated(data.lastUpdated)
                    setRestrictions(data.restrictions || [])
                    setRunwayClosures(data.runwayClosures || {})
                    setOpsPlan(data.opsPlan || null)
                    setAirportOperations(data.airportOperations || null)
                } else if (event === 'status') {
                    setConnected(data.connected)
                }
            }
        }
        connect()
        return () => wsRef.current?.close()
    }, [])

    useEffect(() => {
        function focusSearch(e) {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                searchRef.current?.focus()
            }
        }
        window.addEventListener('keydown', focusSearch)
        return () => window.removeEventListener('keydown', focusSearch)
    }, [])

    // Filter by search
    const q = search.trim().toUpperCase()
    const filtered = useMemo(() => {
        const displayedRestrictions = restrictions.filter(t => DISPLAYED_RESTRICTION_TYPES.has(t.type))
        if (!q) return displayedRestrictions
        return displayedRestrictions.filter(t =>
            t.aerodrome?.includes(q) ||
            t.controlledElement?.toUpperCase().includes(q) ||
            t.nasElement?.toUpperCase().includes(q) ||
            t.name?.toUpperCase().includes(q) ||
            t.providingFacility?.toUpperCase().includes(q)
        )
    }, [restrictions, q])

    const filteredClosures = useMemo(() => {
        if (!q) return runwayClosures
        return Object.fromEntries(
            Object.entries(runwayClosures).filter(([apt]) => apt.includes(q) || apt.replace(/^K/, '').includes(q))
        )
    }, [runwayClosures, q])

    // Build grouped data
    const groups = useMemo(() =>
        GROUPS.map(g => ({
            ...g,
            tmis: filtered.filter(t => g.matches ? g.matches(t) : g.types.includes(t.type)),
        })).filter(g => g.tmis.length > 0)
    , [filtered])

    const hasClosures = Object.keys(filteredClosures).some(k => filteredClosures[k]?.length > 0)
    const hasSearch = q.length > 0

    useEffect(() => {
        setClosuresCollapsed(!hasSearch)
    }, [hasSearch])
    const totalActive = restrictions.filter(t => t.status === 'ACTIVE').length
    const isEmpty = groups.length === 0 && !hasClosures

    return (
        <div className="app-shell">
            {/* Header */}
            <header className="topbar">
                <div className="topbar__inner">
                    <div className="brand-lockup">
                        <div className="brand-mark">✈</div>
                        <div>
                            <h1>In Trail</h1>
                            <p>National airspace watch</p>
                        </div>
                    </div>
                    <div className="topbar__meta">
                        {lastUpdated && (
                            <div className="last-update"><span>LAST SYNC</span><strong>{fmtTime(lastUpdated)}</strong></div>
                        )}
                        <div className={`connection ${connected ? 'connection--live' : 'connection--offline'}`}>
                            <span className="connection__dot" />
                            <span>
                                {connected ? 'LIVE' : 'OFFLINE'}
                            </span>
                        </div>
                    </div>
                </div>
            </header>

            <main className="dashboard">
                <section className="intro">
                    <div>
                        <p className="eyebrow">FAA SWIM / TFDM FEED</p>
                        <h2>Airspace, at a glance.</h2>
                        <p className="intro__copy">Active and upcoming traffic management restrictions across the national airspace system.</p>
                    </div>
                    <div className="intro__signal"><span /> Monitoring live feed</div>
                </section>
                {/* Summary bar */}
                {(restrictions.length > 0 || hasClosures) && (
                    <div className="summary-grid">
                        <div className="stat-card">
                            <span className="stat-card__label">Active TMIs</span>
                            <strong>{totalActive}</strong>
                            <span className="stat-card__hint">traffic measures</span>
                        </div>
                        {hasClosures && (
                            <div className="stat-card stat-card--alert">
                                <span className="stat-card__label">Runway closures</span>
                                <strong>{Object.values(filteredClosures).flat().length}</strong>
                                <span className="stat-card__hint">requiring attention</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Search */}
                <label className="search-box">
                    <span className="search-box__icon">⌕</span>
                    <input ref={searchRef} aria-label="Search airport, fix, or facility" type="text" placeholder="Search airport, fix, or facility" value={search} onChange={e => setSearch(e.target.value)} />
                    <span className="search-box__key">⌘ K</span>
                </label>

                <AirportOperations operations={airportOperations} autoExpand={hasSearch} query={q} />

                {/* Empty state */}
                {isEmpty && (
                    <div className="empty-state">
                        <div className="empty-state__icon">{connected ? '◌' : '×'}</div>
                        <p>
                            {!connected
                                ? 'Connecting to FAA SWIM…'
                                : restrictions.length === 0
                                    ? 'Receiving data from FAA SWIM…'
                                    : 'No active restrictions match your filter.'
                            }
                        </p>
                    </div>
                )}

                {/* Restriction groups */}
                {groups.map(g => (
                    <GroupCard key={g.key} group={g} tmis={g.tmis} autoExpand={hasSearch} />
                ))}

                {/* Runway closures */}
                {hasClosures && (
                    <section className="group-card closures-card">
                        <button className="group-card__header closures-card__header" type="button" aria-expanded={!closuresCollapsed} onClick={() => setClosuresCollapsed(value => !value)}>
                            <h2 className="group-card__title">
                                <span className="group-card__icon">🚧</span><span>Runway closures</span>
                            </h2>
                            <span className="collapse-chevron" aria-hidden="true">{closuresCollapsed ? '+' : '−'}</span>
                        </button>
                        {!closuresCollapsed && <div className="group-card__body">
                            {Object.entries(filteredClosures).map(([apt, closures]) =>
                                closures.length > 0
                                    ? <ClosureRow key={apt} aerodrome={apt} closures={closures} />
                                    : null
                            )}
                        </div>}
                    </section>
                )}
            </main>
        </div>
    )
}
