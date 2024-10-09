import { Feature, Geometry } from 'geojson';
import { CliGeoJsonOptionsType, CliBaseOptionsType } from '..';
import Writer from './Writer.js';

/**
 * Stdout is a Writer implementation that writes output to the console.
 * The format is geojson or geojsonseq.
 */
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
    } else if (this.options.format === 'esrijson') {
      this.strings.header = null;
    }
    if (!this.headerStatus.hasHeader) {
      this.writeHeader();
    }
  }

  close() {
    this.writeFooter();
  }

  /**
    * Writes a string to the console.
    * @param line The string to write.
    */
  writeString(line: string) {
    process.stdout.write(line);
  };

  /**
 * Writes a GeoJSON feature to the console.
 * @param line The GeoJSON feature to write.
 * @returns The same feature that was written.
 */
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
