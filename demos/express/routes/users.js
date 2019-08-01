var express = require('express');
var router = express.Router();

/* GET users listing. */
router.get('/', function(req, res, next) {
  res.send('Users page content, resume debugger.');
  debugger;
});

module.exports = router;
