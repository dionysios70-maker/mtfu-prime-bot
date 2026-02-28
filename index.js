function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = JSON.parse(e.postData.contents);

  sheet.clearContents();
  sheet.appendRow(["Discord ID", "Expiry Timestamp", "Expiry Date", "Remaining Days"]);

  const today = new Date();

  data.members.forEach(member => {
    const expiryDate = new Date(member.expiry);
    const remainingDays = Math.ceil((member.expiry - today.getTime()) / (1000 * 60 * 60 * 24));

    sheet.appendRow([
      member.userId,
      member.expiry,
      expiryDate,
      remainingDays
    ]);
  });

  return ContentService.createTextOutput("Backup complete");
}

function doGet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();

  const members = [];

  for (let i = 1; i < data.length; i++) {
    members.push({
      userId: data[i][0],
      expiry: Number(data[i][1])
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ members }))
    .setMimeType(ContentService.MimeType.JSON);
}
