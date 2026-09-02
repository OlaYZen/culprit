"""culprit -- live Linux health, process and event monitoring.

Layout:

    config.py            defaults + config.json overrides + validation
    linux.py             /proc, /sys, cgroup, journal and systemctl helpers
    util.py              rate maths, ring buffer, sustain counters
    state.py             shared snapshot store + SSE fan-out
    db.py                SQLite history (rollups, events, findings)
    sampler.py           the four sampling loops
    main.py              FastAPI routes
    collectors/          one module per data domain
"""

__version__ = "2.0.1"
