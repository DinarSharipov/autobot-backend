import { Injectable } from '@nestjs/common';

type MetricLabels = Record<string, string | number | boolean>;

type Counter = {
  name: string;
  labels: MetricLabels;
  value: number;
};

type Gauge = Counter;

type Histogram = {
  name: string;
  labels: MetricLabels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
};

const DEFAULT_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function labelsKey(labels: MetricLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(',')}}`;
}

@Injectable()
export class MetricsService {
  private readonly processStartTimeSeconds = Math.floor(Date.now() / 1000 - process.uptime());
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = `${name}|${labelsKey(labels)}`;
    const current = this.counters.get(key);
    if (current) {
      current.value += value;
      return;
    }
    this.counters.set(key, { name, labels: { ...labels }, value });
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = `${name}|${labelsKey(labels)}`;
    this.gauges.set(key, { name, labels: { ...labels }, value });
  }

  observe(
    name: string,
    value: number,
    labels: MetricLabels = {},
    buckets = DEFAULT_DURATION_BUCKETS,
  ): void {
    const key = `${name}|${labelsKey(labels)}`;
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = {
        name,
        labels: { ...labels },
        buckets: [...buckets].sort((left, right) => left - right),
        counts: buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += value;
    histogram.buckets.forEach((bucket, index) => {
      if (value <= bucket) histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
    });
  }

  renderPrometheus(): string {
    const lines: string[] = [
      '# HELP autobot_process_start_time_seconds Unix timestamp when the process started.',
      '# TYPE autobot_process_start_time_seconds gauge',
      `autobot_process_start_time_seconds ${this.processStartTimeSeconds}`,
    ];

    for (const metric of this.counters.values()) {
      lines.push(`# TYPE ${metric.name} counter`);
      lines.push(`${metric.name}${renderLabels(metric.labels)} ${metric.value}`);
    }
    for (const metric of this.gauges.values()) {
      lines.push(`# TYPE ${metric.name} gauge`);
      lines.push(`${metric.name}${renderLabels(metric.labels)} ${metric.value}`);
    }
    for (const metric of this.histograms.values()) {
      lines.push(`# TYPE ${metric.name} histogram`);
      metric.buckets.forEach((bucket, index) => {
        lines.push(
          `${metric.name}_bucket${renderLabels({ ...metric.labels, le: bucket })} ${metric.counts[index]}`,
        );
      });
      lines.push(
        `${metric.name}_bucket${renderLabels({ ...metric.labels, le: '+Inf' })} ${metric.count}`,
      );
      lines.push(`${metric.name}_sum${renderLabels(metric.labels)} ${metric.sum}`);
      lines.push(`${metric.name}_count${renderLabels(metric.labels)} ${metric.count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
