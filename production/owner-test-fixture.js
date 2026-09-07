// Synthetic, public-safe fixtures for owner integration tests. No workbook data.
export function ownerFixture() {
  const weeks=Array.from({length:52},(_,i)=>new Date(Date.UTC(2026,0,4+i*7)).toISOString().slice(0,10));
  const line=(id,label,m)=>({id,label,sales:{newSales:52000*m,carryOver:0,recurring:0,leadConversion:.5,salesRatio:.5,averageJobSize:1000,weekly:weeks.map(weekEnding=>({weekEnding,weight:1/52,actual:{}}))},revenue:{annualProduced:52000*m,chargeRate:50,weekly:weeks.map(weekEnding=>({weekEnding,weight:1/52,actual:{}}))}});
  return {schemaVersion:1,year:2026,weekEndings:weeks,asOfWeekEnding:weeks[35],lines:[line('painting','Painting',1),line('epoxy','Epoxy',2)]};
}
