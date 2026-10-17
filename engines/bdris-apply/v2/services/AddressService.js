/**
 * AddressService — Address cascade operations
 *
 * Principles:
 * - Single entry point for all address queries
 * - Static data for division/district (fast)
 * - Engine for zone/ward (realtime from BDRIS)
 * - No frontend mirroring needed
 */

const { BdrisNavigator } = require('./BdrisNavigator');

class AddressService {
  constructor(navigator) {
    this.navigator = navigator; // BdrisNavigator instance
    this.staticCache = null;
  }

  async loadStaticData() {
    if (this.staticCache) return this.staticCache;
    // Static BD geo data (divisions, districts, upazilas)
    // Loaded from bd-geo.json
    try {
      const fs = require('fs');
      const path = require('path');
      const geoPath = path.join(__dirname, '../../../frontend/bd-geo.json');
      const data = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
      this.staticCache = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  getStaticOptions(level, parents = {}) {
    if (!this.staticCache) return [];
    // Implementation depends on bd-geo.json structure
    // Returns [] if not available, caller falls back to engine
    try {
      const { divisions } = this.staticCache;
      if (level === 'division') {
        return Object.keys(divisions || {}).map(name => ({ id: name, name }));
      }
      if (level === 'district' && parents.division) {
        const div = divisions[parents.division];
        if (div && div.districts) {
          return Object.keys(div.districts).map(name => ({ id: name, name }));
        }
      }
      if (level === 'upazila' && parents.division && parents.district) {
        const div = divisions[parents.division];
        const dist = div?.districts?.[parents.district];
        if (dist && dist.upazilas) {
          return dist.upazilas.map(name => ({ id: name, name }));
        }
      }
    } catch (e) {
      // Fall through to engine
    }
    return [];
  }

  /**
   * Get options for an address level
   * - division/district/upazila: static first, engine fallback
   * - zone/ward: always engine (realtime from BDRIS, never hardcoded)
   */
  async getOptions(level, parents = {}, form = 'birth') {
    // Zone/ward MUST come from engine (user requirement: realtime, no hardcode)
    if (level === 'zone' || level === 'ward') {
      return await this.navigator.getAddressOptions(level, parents, form);
    }

    // Others: try static first
    await this.loadStaticData();
    const staticOpts = this.getStaticOptions(level, parents);
    if (staticOpts.length) return staticOpts;

    // Fallback to engine
    return await this.navigator.getAddressOptions(level, parents, form);
  }
}

module.exports = { AddressService };
