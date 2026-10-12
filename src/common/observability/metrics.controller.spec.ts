import { describe, expect, it } from 'vitest';

import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('renders counters, gauges, and histograms with escaped labels', () => {
    const metrics = new MetricsService();
    metrics.increment('autobot_http_requests_total', { route: '/posts', status: 200 });
    metrics.setGauge('autobot_queue_jobs', 3, { queue: 'publication' });
    metrics.observe('autobot_http_request_duration_seconds', 0.2, {
      route: 'say "hello"',
    });

    const output = metrics.renderPrometheus();

    expect(output).toContain('autobot_http_requests_total{route="/posts",status="200"} 1');
    expect(output).toContain('autobot_queue_jobs{queue="publication"} 3');
    expect(output).toContain('route="say \\"hello\\""');
    expect(output).toContain(
      'autobot_http_request_duration_seconds_count{route="say \\"hello\\""} 1',
    );
  });
});
