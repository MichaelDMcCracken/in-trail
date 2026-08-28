const GUIDE_SECTIONS = [
    {
        title: 'Start with the headline',
        text: 'The dashboard shows active and upcoming traffic management restrictions across the national airspace system. The summary cards give you a quick count before you scan the individual measures.',
    },
    {
        title: 'Search by airport or facility',
        content: <>Use the search field to find an airport, ARTCC, TRACON, route, or restriction. Search multiple airports at once by separating their codes with spaces or commas, such as <code>MCO RDU</code> or <code>MCO, RDU</code>. Airport searches work with either the three-letter IATA code or the four-letter ICAO code, such as <code>MCO</code> or <code>KMCO</code>.</>,
    },
    {
        title: 'Read the status and timing',
        text: 'ACTIVE measures are currently in effect. PROPOSED measures are planned or pending. Time displays use UTC with a Z suffix, and the relative time makes it easier to see how long a measure has left.',
    },
    {
        title: 'Open the details you need',
        text: 'Select a section header to expand or collapse a group. Reroutes open to show the affected area, requirement, facilities, and route details. Hover or focus a facility code for its full name.',
    },
]

const TERMS = [
    ['MIT / MINIT', 'Miles or minutes in trail: spacing required between aircraft.'],
    ['GROUND STOP', 'A temporary stop on departures headed to a destination or area.'],
    ['REROUTE', 'A required or recommended alternate route around a constrained area.'],
    ['EDCT', 'Expect departure clearance time: the planned release time for a flight.'],
]

export default function Guide({ onBack }) {
    return (
        <main className="guide-page">
            <div className="guide-page__topline">
                <button className="guide-back" type="button" onClick={onBack}>
                    <span aria-hidden="true">←</span> Back to airspace watch
                </button>
                <span className="eyebrow">FIELD GUIDE / IN TRAIL</span>
            </div>

            <header className="guide-hero">
                <p className="guide-hero__kicker">A quick orientation</p>
                <h2>Make sense of the airspace picture.</h2>
                <p>In Trail turns live FAA traffic measures into a concise view of what is active, what is coming, and where operations may be affected.</p>
            </header>

            <section className="guide-section guide-section--steps" aria-labelledby="guide-start-heading">
                <div className="guide-section__heading">
                    <span className="guide-index">01</span>
                    <h3 id="guide-start-heading">A few useful habits</h3>
                </div>
                <div className="guide-steps">
                    {GUIDE_SECTIONS.map((section, index) => (
                        <article className="guide-step" key={section.title}>
                            <span className="guide-step__number">{String(index + 1).padStart(2, '0')}</span>
                            <div>
                                <h4>{section.title}</h4>
                                <p>{section.content || section.text}</p>
                            </div>
                        </article>
                    ))}
                </div>
            </section>

            <section className="guide-section" aria-labelledby="guide-terms-heading">
                <div className="guide-section__heading">
                    <span className="guide-index">02</span>
                    <h3 id="guide-terms-heading">The short version of the jargon</h3>
                </div>
                <dl className="guide-terms">
                    {TERMS.map(([term, definition]) => (
                        <div key={term}>
                            <dt>{term}</dt>
                            <dd>{definition}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section className="guide-note" aria-label="Data note">
                <span className="guide-note__mark" aria-hidden="true">i</span>
                <p>Data comes from the FAA SWIM and TFDM feeds. In Trail is an information display, not an operational clearance or substitute for official FAA advisories.</p>
            </section>
        </main>
    )
}
