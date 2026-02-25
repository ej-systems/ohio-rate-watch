/**
 * Ohio Rate Watch — Historical Rate Chart
 * Multi-utility SCO chart with 2018-present / long-term (2000+) toggle
 * Updated: 2026-02-25
 */

(function () {
  'use strict';

  const COLORS = {
    columbia:    '#e53935',  // red — primary
    enbridge:    '#7b1fa2',  // purple
    centerpoint: '#f57c00',  // orange
    eiaRef:      '#9ca3af',  // gray — EIA reference (pre-2018)
    henryHub:    '#1565c0',  // blue
    bestFixed:   '#16a34a',  // green
    boundary:    '#6b7280',  // gray vertical line
    grid:        '#f0f0f0',
    tooltipBg:   '#1a1a2e',
  };

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let chartInstance = null;
  let currentRange = 'default';

  function buildDatasetMap(entries) {
    const map = {};
    (entries || []).forEach(d => { map[d.date] = d.value; });
    return map;
  }

  function fmtDate(label) {
    const [y, m] = (label || '').split('-');
    return MONTHS[parseInt(m) - 1] + ' ' + y;
  }

  function buildAnnotations(data, allDates) {
    const annotations = {};

    (data.events || []).forEach((evt, i) => {
      if (!allDates.includes(evt.date)) return;
      annotations['event' + i] = {
        type: 'line',
        xMin: evt.date,
        xMax: evt.date,
        borderColor: 'rgba(156,163,175,0.45)',
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

    // PUCO boundary line (longterm only)
    if (data.pucoBoundary && allDates.includes(data.pucoBoundary)) {
      annotations.pucoBoundary = {
        type: 'line',
        xMin: data.pucoBoundary,
        xMax: data.pucoBoundary,
        borderColor: 'rgba(107,114,128,0.6)',
        borderWidth: 2,
        borderDash: [6, 3],
        label: {
          display: true,
          content: '📋 PUCO Official SCO data begins',
          position: 'end',
          backgroundColor: 'rgba(255,255,255,0.92)',
          color: '#374151',
          font: { size: 10, weight: '600' },
          padding: { top: 3, bottom: 3, left: 6, right: 6 },
          borderRadius: 4,
        }
      };
    }

    // Best fixed annotation
    if (data.bestFixed && data.bestFixed > 0.1) {
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

    return annotations;
  }

  function buildDatasets(data, allDates, longterm) {
    const colMap  = buildDatasetMap(data.columbiaGasSco || data.sco);
    const engMap  = buildDatasetMap(data.enbridgeGasSco);
    const cpeMap  = buildDatasetMap(data.centerpointSco);
    const hhMap   = buildDatasetMap(data.henryHub);
    const eiaMap  = buildDatasetMap(data.eiaOhioRef);

    const nullIfMissing = (map, d) => {
      const v = map[d];
      return v !== undefined ? v : null;
    };

    const datasets = [];

    if (longterm) {
      // EIA Ohio Residential (gray) — 2000–2017
      datasets.push({
        label: 'Ohio Residential Avg — EIA (pre-2018 reference)',
        data: allDates.map(d => nullIfMissing(eiaMap, d)),
        borderColor: COLORS.eiaRef,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 1,
        pointHoverRadius: 4,
        borderDash: [4, 2],
        fill: false,
        tension: 0.3,
        spanGaps: false,
      });
    }

    // Columbia Gas (red, filled — primary)
    datasets.push({
      label: 'Columbia Gas SCO ($/ccf)',
      data: allDates.map(d => nullIfMissing(colMap, d)),
      borderColor: COLORS.columbia,
      backgroundColor: 'rgba(229,57,53,0.07)',
      borderWidth: 2.5,
      pointRadius: longterm ? 1 : 2,
      pointHoverRadius: 6,
      pointBackgroundColor: COLORS.columbia,
      fill: true,
      tension: 0.3,
      spanGaps: false,
    });

    if (!longterm) {
      // CenterPoint (orange dashed)
      datasets.push({
        label: 'CenterPoint Energy SCO ($/ccf)',
        data: allDates.map(d => nullIfMissing(cpeMap, d)),
        borderColor: COLORS.centerpoint,
        backgroundColor: 'transparent',
        borderWidth: 1.8,
        pointRadius: 1.5,
        pointHoverRadius: 5,
        borderDash: [4, 3],
        fill: false,
        tension: 0.3,
        spanGaps: false,
      });

      // Enbridge (purple dashed)
      datasets.push({
        label: 'Enbridge Gas Ohio SCO ($/ccf)',
        data: allDates.map(d => nullIfMissing(engMap, d)),
        borderColor: COLORS.enbridge,
        backgroundColor: 'transparent',
        borderWidth: 1.8,
        pointRadius: 1.5,
        pointHoverRadius: 5,
        borderDash: [4, 3],
        fill: false,
        tension: 0.3,
        spanGaps: false,
      });
    }

    // Henry Hub (blue dashed)
    datasets.push({
      label: 'Henry Hub ($/ccf equiv.)',
      data: allDates.map(d => nullIfMissing(hhMap, d)),
      borderColor: COLORS.henryHub,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 1,
      pointHoverRadius: 4,
      borderDash: [6, 4],
      fill: false,
      tension: 0.3,
      spanGaps: false,
    });

    return datasets;
  }

  async function renderChart(range) {
    const canvas = document.getElementById('rate-history-chart');
    if (!canvas) return;

    const longterm = range === 'longterm';
    const url = '/api/history/chart-data' + (longterm ? '?range=longterm' : '');

    let data;
    try {
      const res = await fetch(url);
      data = await res.json();
    } catch (err) {
      console.error('Failed to load chart data:', err);
      canvas.parentElement.innerHTML =
        '<p style="color:#999;text-align:center;padding:40px;">Chart data unavailable. Please try again later.</p>';
      return;
    }

    // Build unified date axis
    const START_DATE = longterm ? '2000-01' : '2018-01';
    const colMap  = buildDatasetMap(data.columbiaGasSco || data.sco);
    const engMap  = buildDatasetMap(data.enbridgeGasSco);
    const cpeMap  = buildDatasetMap(data.centerpointSco);
    const hhMap   = buildDatasetMap(data.henryHub);
    const eiaMap  = buildDatasetMap(data.eiaOhioRef);

    const allDates = Array.from(new Set([
      ...Object.keys(eiaMap).filter(d => d >= START_DATE),
      ...Object.keys(colMap).filter(d => d >= START_DATE),
      ...Object.keys(engMap).filter(d => d >= START_DATE),
      ...Object.keys(cpeMap).filter(d => d >= START_DATE),
      ...Object.keys(hhMap).filter(d => d >= START_DATE),
    ])).sort();

    const annotations = buildAnnotations(data, allDates);
    const datasets    = buildDatasets(data, allDates, longterm);

    // Destroy previous chart instance if any
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    chartInstance = new Chart(canvas, {
      type: 'line',
      data: { labels: allDates, datasets },
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
              title: items => fmtDate(items[0].label),
              label: ctx => {
                if (ctx.parsed.y === null) return null;
                const name = ctx.dataset.label.split(' (')[0];
                return name + ': $' + ctx.parsed.y.toFixed(3) + '/ccf';
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
                const [, m] = label.split('-');
                const tick = longterm
                  ? (m === '01')         // yearly labels in long-term
                  : (m === '01' || m === '07');  // bi-annual in default
                return tick ? fmtDate(label) : '';
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

  function injectToggle(container) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
    wrapper.innerHTML = `
      <button id="chart-btn-default"
        style="padding:6px 14px;border-radius:6px;border:1.5px solid #e53935;background:#e53935;color:#fff;font-size:0.85rem;font-weight:600;cursor:pointer;">
        2018 – Present
      </button>
      <button id="chart-btn-longterm"
        style="padding:6px 14px;border-radius:6px;border:1.5px solid #d1d5db;background:#fff;color:#374151;font-size:0.85rem;font-weight:600;cursor:pointer;">
        Since 2000
      </button>
    `;
    container.insertBefore(wrapper, container.firstChild);

    function setActive(range) {
      const dflt = document.getElementById('chart-btn-default');
      const lt   = document.getElementById('chart-btn-longterm');
      if (range === 'default') {
        dflt.style.cssText = 'padding:6px 14px;border-radius:6px;border:1.5px solid #e53935;background:#e53935;color:#fff;font-size:0.85rem;font-weight:600;cursor:pointer;';
        lt.style.cssText   = 'padding:6px 14px;border-radius:6px;border:1.5px solid #d1d5db;background:#fff;color:#374151;font-size:0.85rem;font-weight:600;cursor:pointer;';
      } else {
        dflt.style.cssText = 'padding:6px 14px;border-radius:6px;border:1.5px solid #d1d5db;background:#fff;color:#374151;font-size:0.85rem;font-weight:600;cursor:pointer;';
        lt.style.cssText   = 'padding:6px 14px;border-radius:6px;border:1.5px solid #e53935;background:#e53935;color:#fff;font-size:0.85rem;font-weight:600;cursor:pointer;';
      }
    }

    document.getElementById('chart-btn-default').addEventListener('click', () => {
      if (currentRange === 'default') return;
      currentRange = 'default';
      setActive('default');
      renderChart('default');
    });

    document.getElementById('chart-btn-longterm').addEventListener('click', () => {
      if (currentRange === 'longterm') return;
      currentRange = 'longterm';
      setActive('longterm');
      renderChart('longterm');
    });
  }

  async function init() {
    const canvas = document.getElementById('rate-history-chart');
    if (!canvas) return;

    // Find chart container and inject toggle buttons above it
    const chartContainer = canvas.parentElement;
    if (chartContainer) injectToggle(chartContainer.parentElement);

    await renderChart('default');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
