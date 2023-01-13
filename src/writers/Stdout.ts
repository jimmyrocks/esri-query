import { Feature, Geometry } from 'geojson';
import { CliGeoJsonOptionsType, CliBaseOptionsType } from '..';
import Writer from './Writer.js';

export default class Stdout extends Writer {
  strings = {
    header: '{"type": "FeatureCollection", "features": [',
    footer: ']}',
    bboxFooter: '], "bbox":{bbox}}',
    delimiter: ','
  };
  headerStatus = {
    hasHeader: false,
    hasFooter: false,
    closed: false,
  }
  declare options: CliBaseOptionsType & CliGeoJsonOptionsType

  open() {
    if (this.options.format === 'geojsonseq') {
      this.strings.header = this.strings.footer = this.strings.bboxFooter = null;
      this.strings.delimiter = '\n';
    }
    if (!this.headerStatus.hasHeader) {
      this.writeHeader();
    }
  }

  close() {
    this.writeFooter();
  }

  writeString(line: string) {
    process.stdout.write(line);
  };

  writeFeature(line: Feature<Geometry, { [name: string]: any; }>): Feature<Geometry, { [name: string]: any; }> {
    line = super.writeFeature(line);
    const lineStr = JSON.stringify(line, null, this.options.pretty ? 2 : 0);
    if (this.status.records > 1) this.writeString(this.strings.delimiter);
    this.writeString(lineStr);
    return line;
  }

  writeHeader() {
    const { hasHeader, closed } = this.headerStatus;
    if (this.status.records === 0 && !hasHeader && !closed && this.strings['header']) {
      this.writeString(this.strings.header);
    } else if (hasHeader) {
      throw new Error('Header already added');
    }
    this.headerStatus.hasHeader = true;
    this.status.canWrite = true;
  }

  writeFooter() {
    const { hasFooter, hasHeader, closed } = this.headerStatus;
    const { bboxFooter, footer } = this.strings;
    if (footer === null || bboxFooter === null) return;

    let thisFooter = this.options['no-bbox'] ? footer : bboxFooter.replace('{bbox}', JSON.stringify(this.status.bbox));
    if (hasHeader && !hasFooter && !closed) {
      this.writeString(thisFooter);
    } else {
      throw new Error(hasFooter ? 'Footer already added' : 'No header exists');
    }
    this.headerStatus.hasFooter = true;
    this.status.canWrite = false;
  }

};
