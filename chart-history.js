/**
 * Ohio Rate Watch — Historical Rate Chart
 * Multi-utility SCO chart: Columbia Gas, Enbridge, CenterPoint + Henry Hub reference
 * Updated: 2026-02-25
 */

(function () {
  'use strict';

  const COLORS = {
    columbia:   '#e53935',  // red — primary utility
    enbridge:   '#7b1fa2',  // purple
    centerpoint:'#f57c00',  // orange
    henryHub:   '#1565c0',  // blue
    bestFixed:  '#16a34a',  // green
    grid:       '#f0f0f0',
    tooltipBg:  '#1a1a2e',
  };

  function buildDatasetMap(entries) {
    const map = {};
    (entries || []).forEach(d => { map[d.date] = d.value; });
    return map;
  }

  async function init() {
    const canvas = document.getElementById('rate-history-chart');
    if (!canvas) return;

    let data;
    try {
      const res = await fetch('/api/history/chart-data');
      data = await res.json();
    } catch (err) {
      console.error('Failed to load chart data:', err);
      canvas.parentElement.innerHTML =
        '<p style="color:#999;text-align:center;padding:40px;">Chart data unavailable. Please try again later.</p>';
      return;
    }

    // Build per-utility lookup maps
    const colMap  = buildDatasetMap(data.columbiaGasSco  || data.sco);  // fallback to old key
    const engMap  = buildDatasetMap(data.enbridgeGasSco);
    const cpeMap  = buildDatasetMap(data.centerpointSco);
    const hhMap   = buildDatasetMap(data.henryHub);

    // Collect all unique dates across SCO datasets only (2018+), sorted
    // Henry Hub goes back to 1997 — clamp to SCO range for readability
    const START_DATE = '2018-01';
    const allDates = Array.from(new Set([
      ...Object.keys(colMap),
      ...Object.keys(engMap),
      ...Object.keys(cpeMap),
      ...Object.keys(hhMap).filter(d => d >= START_DATE),
    ])).sort();

    const nullIfMissing = (map, date) => {
      const v = map[date];
      return v !== undefined ? v : null;
    };

    // Build annotations
    const annotations = {};
    (data.events || []).forEach((evt, i) => {
      annotations['event' + i] = {
        type: 'line',
        xMin: evt.date,
        xMax: evt.date,
        borderColor: 'rgba(156,163,175,0.5)',
        borderWidth: 1,
        borderDash: [4, 4],
        label: {
          display: true,
          content: evt.icon + ' ' + evt.label,
          position: 'start',
          backgroundColor: 'rgba(255,255,255,0.92)',
          color: '#374151',
          font: { size: 10, weight: '600' },
          padding: { top: 3, bottom: 3, left: 6, right: 6 },
          borderRadius: 4,
        }
      };
    });

    if (data.bestFixed) {
      annotations.bestFixed = {
        type: 'line',
        yMin: data.bestFixed,
        yMax: data.bestFixed,
        borderColor: COLORS.bestFixed,
        borderWidth: 2,
        borderDash: [8, 4],
        label: {
          display: true,
          content: 'Best Fixed: $' + Number(data.bestFixed).toFixed(3) + '/ccf',
          position: 'end',
          backgroundColor: COLORS.bestFixed,
          color: '#fff',
          font: { size: 11, weight: '700' },
          padding: { top: 4, bottom: 4, left: 8, right: 8 },
          borderRadius: 4,
        }
      };
    }

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    new Chart(canvas, {
      type: 'line',
      data: {
        labels: allDates,
        datasets: [
          {
            label: 'Columbia Gas SCO ($/ccf)',
            data: allDates.map(d => nullIfMissing(colMap, d)),
            borderColor: COLORS.columbia,
            backgroundColor: 'rgba(229,57,53,0.07)',
            borderWidth: 2.5,
            pointRadius: 2,
            pointHoverRadius: 6,
            pointBackgroundColor: COLORS.columbia,
            fill: true,
            tension: 0.3,
            spanGaps: false,
          },
          {
            label: 'CenterPoint Energy SCO ($/ccf)',
            data: allDates.map(d => nullIfMissing(cpeMap, d)),
            borderColor: COLORS.centerpoint,
            backgroundColor: 'transparent',
            borderWidth: 1.8,
            pointRadius: 1.5,
            pointHoverRadius: 5,
            pointBackgroundColor: COLORS.centerpoint,
            borderDash: [4, 3],
            fill: false,
            tension: 0.3,
            spanGaps: false,
          },
          {
            label: 'Enbridge Gas Ohio SCO ($/ccf)',
            data: allDates.map(d => nullIfMissing(engMap, d)),
            borderColor: COLORS.enbridge,
            backgroundColor: 'transparent',
            borderWidth: 1.8,
            pointRadius: 1.5,
            pointHoverRadius: 5,
            pointBackgroundColor: COLORS.enbridge,
            borderDash: [4, 3],
            fill: false,
            tension: 0.3,
            spanGaps: false,
          },
          {
            label: 'Henry Hub ($/ccf equiv.)',
            data: allDates.map(d => nullIfMissing(hhMap, d)),
            borderColor: COLORS.henryHub,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 1,
            pointHoverRadius: 4,
            pointBackgroundColor: COLORS.henryHub,
            borderDash: [6, 4],
            fill: false,
            tension: 0.3,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              usePointStyle: true,
              padding: 14,
              font: { size: 11, weight: '600' },
            },
          },
          tooltip: {
            backgroundColor: COLORS.tooltipBg,
            titleFont: { size: 13, weight: '700' },
            bodyFont: { size: 12 },
            padding: 12,
            cornerRadius: 8,
            filter: ctx => ctx.parsed.y !== null,
            callbacks: {
              title: items => {
                const [y, m] = items[0].label.split('-');
                return MONTHS[parseInt(m) - 1] + ' ' + y;
              },
              label: ctx => {
                if (ctx.parsed.y === null) return null;
                return ctx.dataset.label.split(' (')[0] + ': $' + ctx.parsed.y.toFixed(3) + '/ccf';
              },
            },
          },
          annotation: { annotations },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { size: 10 },
              color: '#9ca3af',
              maxRotation: 45,
              callback: function (val) {
                const label = this.getLabelForValue(val);
                if (typeof label !== 'string') return '';
                const [y, m] = label.split('-');
                if (m === '01' || m === '07') return MONTHS[parseInt(m) - 1] + ' ' + y;
                return '';
              },
            },
          },
          y: {
            beginAtZero: false,
            min: 0.10,
            grid: { color: COLORS.grid },
            ticks: {
              font: { size: 11 },
              color: '#9ca3af',
              callback: val => '$' + val.toFixed(2),
            },
            title: {
              display: true,
              text: '$/ccf',
              font: { size: 12, weight: '600' },
              color: '#6b7280',
            },
          },
        },
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
