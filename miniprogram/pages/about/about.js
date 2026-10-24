const app = getApp();

Page({
  data: { version: "", countryDate: "" },
  onLoad() {
    const engine = app.engine();
    this.setData({ version: engine.version, countryDate: engine.COUNTRY_DATA_DATE });
  },
});
