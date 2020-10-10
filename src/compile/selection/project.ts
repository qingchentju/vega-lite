import {array, isObject} from 'vega-util';
import {
  getPositionChannelFromLatLong,
  isGeoPositionChannel,
  isScaleChannel,
  isSingleDefUnitChannel,
  SingleDefUnitChannel
} from '../../channel';
import * as log from '../../log';
import {hasContinuousDomain} from '../../scale';
import {BaseSelectionConfig, SelectionInitIntervalMapping, SelectionInitMapping} from '../../selection';
import {Dict, hash, keys, replacePathInField, varName, isEmpty} from '../../util';
import {TimeUnitComponent, TimeUnitNode} from '../data/timeunit';
import {SelectionCompiler} from '.';
export const TUPLE_FIELDS = '_tuple_fields';

/**
 * Whether the selection tuples hold enumerated or ranged values for a field.
 */
export type TupleStoreType =
  // enumerated
  | 'E'
  // ranged, exclusive, left-right inclusive
  | 'R'
  // ranged, left-inclusive, right-exclusive
  | 'R-RE';

export interface SelectionProjection {
  type: TupleStoreType;
  field: string;
  channel?: SingleDefUnitChannel;
  signals?: {data?: string; visual?: string};
  hasLegend?: boolean;
}

export class SelectionProjectionComponent {
  public hasChannel: Partial<Record<SingleDefUnitChannel, SelectionProjection>>;
  public hasField: Record<string, SelectionProjection>;
  public timeUnit?: TimeUnitNode;
  public items: SelectionProjection[];

  constructor(...items: SelectionProjection[]) {
    this.items = items;
    this.hasChannel = {};
    this.hasField = {};
  }
}

const project: SelectionCompiler = {
  defined: () => {
    return true; // This transform handles its own defaults, so always run parse.
  },

  parse: (model, selCmpt, selDef) => {
    const name = selCmpt.name;
    const proj = (selCmpt.project ??= new SelectionProjectionComponent());
    const parsed: Dict<SelectionProjection> = {};
    const timeUnits: Dict<TimeUnitComponent> = {};

    const signals = new Set<string>();
    const signalName = (p: SelectionProjection, range: 'data' | 'visual') => {
      const suffix = range === 'visual' ? p.channel : p.field;
      let sg = varName(`${name}_${suffix}`);
      for (let counter = 1; signals.has(sg); counter++) {
        sg = varName(`${name}_${suffix}_${counter}`);
      }
      signals.add(sg);
      return {[range]: sg};
    };

    const type = selCmpt.type;
    const cfg = model.config.selection[type];
    const init =
      selDef.value !== undefined
        ? (array(selDef.value as any) as SelectionInitMapping[] | SelectionInitIntervalMapping[])
        : null;

    // If no explicit projection (either fields or encodings) is specified, set some defaults.
    // If an initial value is set, try to infer projections.
    let {fields, encodings} = isObject(selDef.select) ? selDef.select : ({} as BaseSelectionConfig);
    if (!fields && !encodings && init) {
      for (const initVal of init) {
        // initVal may be a scalar value to smoothen varParam -> pointSelection gradient.
        if (!isObject(initVal)) {
          continue;
        }

        for (const key of keys(initVal)) {
          if (isSingleDefUnitChannel(key)) {
            (encodings || (encodings = [])).push(key as SingleDefUnitChannel);
          } else {
            if (type === 'interval') {
              log.warn(log.message.INTERVAL_INITIALIZED_WITH_X_Y);
              encodings = cfg.encodings;
            } else {
              (fields || (fields = [])).push(key);
            }
          }
        }
      }
    }

    // If no initial value is specified, use the default configuration.
    // We break this out as a separate if block (instead of an else condition)
    // to account for unprojected point selections that have scalar initial values
    if (!fields && !encodings) {
      encodings = cfg.encodings;
      fields = cfg.fields;
    }

    for (const channel of encodings ?? []) {
      const fieldDef = model.fieldDef(channel);
      if (fieldDef) {
        let field = fieldDef.field;

        if (fieldDef.aggregate) {
          log.warn(log.message.cannotProjectAggregate(channel, fieldDef.aggregate));
          continue;
        } else if (!field) {
          log.warn(log.message.cannotProjectOnChannelWithoutField(channel));
          continue;
        }

        if (fieldDef.timeUnit) {
          field = model.vgField(channel);
          // Construct TimeUnitComponents which will be combined into a
          // TimeUnitNode. This node may need to be inserted into the
          // dataflow if the selection is used across views that do not
          // have these time units defined.
          const component = {
            timeUnit: fieldDef.timeUnit,
            as: field,
            field: fieldDef.field
          };

          timeUnits[hash(component)] = component;
        }

        // Prevent duplicate projections on the same field.
        // TODO: what if the same field is bound to multiple channels (e.g., SPLOM diag).
        if (!parsed[field]) {
          // Determine whether the tuple will store enumerated or ranged values.
          // Interval selections store ranges for continuous scales, and enumerations otherwise.
          // Single/multi selections store ranges for binned fields, and enumerations otherwise.
          const tplType: TupleStoreType =
            type === 'interval' &&
            isScaleChannel(channel) &&
            hasContinuousDomain(model.getScaleComponent(channel).get('type'))
              ? 'R'
              : fieldDef.bin
              ? 'R-RE'
              : 'E';

          const posChannel = isGeoPositionChannel(channel) ? getPositionChannelFromLatLong(channel) : channel;
          const p: SelectionProjection = {
            field,
            channel: posChannel,
            type: tplType
          };
          p.signals = {...signalName(p, 'data'), ...signalName(p, 'visual')};
          proj.items.push((parsed[field] = p));
          proj.hasField[field] = proj.hasChannel[posChannel] = parsed[field];
        }
      } else {
        log.warn(log.message.cannotProjectOnChannelWithoutField(channel));
      }
    }

    // TODO: find a possible channel mapping for these fields.
    for (const field of fields ?? []) {
      if (proj.hasField[field]) continue;
      const p: SelectionProjection = {type: 'E', field};
      p.signals = {...signalName(p, 'data')};
      proj.items.push(p);
      proj.hasField[field] = p;
    }

    if (init) {
      selCmpt.init = (init as any).map((v: SelectionInitMapping | SelectionInitIntervalMapping) => {
        // Selections can be initialized either with a full object that maps projections to values
        // or scalar values to smoothen the abstraction gradient from variable params to point selections.
        return proj.items.map(p => (isObject(v) ? (v[p.channel] !== undefined ? v[p.channel] : v[p.field]) : v));
      });
    }

    if (!isEmpty(timeUnits)) {
      proj.timeUnit = new TimeUnitNode(null, timeUnits);
    }
  },

  signals: (model, selCmpt, allSignals) => {
    const name = selCmpt.name + TUPLE_FIELDS;
    const hasSignal = allSignals.filter(s => s.name === name);
    return hasSignal.length > 0
      ? allSignals
      : allSignals.concat({
          name,
          value: selCmpt.project.items.map(proj => {
            const {signals, hasLegend, ...rest} = proj;
            rest.field = replacePathInField(rest.field);
            return rest;
          })
        });
  }
};

export default project;
