const util = require("util"),
      fs = require("fs"),
      http = require("http"),
      url = require("url"),
      path = require("path"),
      
      aws = require("aws-lib"),
      mongo = require("mongodb"),
      express = require("express"),
      async = require("async"),
      _ = require("underscore"),
      prettyjson = require("prettyjson"),
      
      date = require("./date"),
      jsoncomp = require("./json-compare");

// -----------------------------------------------------------------------------

// Load application settings
var settings = JSON.parse(fs.readFileSync(__dirname+"/server-settings.json"));

// Amazon AWS API
ec2 = aws.createEC2Client(settings.aws.accessKey, settings.aws.secretKey, {
  version: "2011-12-15"
});

// MongoDB
var mongo_server = new mongo.Server(settings.mongodb.host, settings.mongodb.port, {});

var ec2db;
new mongo.Db(mongodb.db, mongo_server, {}).open(function (error, client) {
  if (error) throw error;
  ec2db = client;
});

// Setup Webserver
var app = express.createServer();

app.configure(function() {
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.set('view options', {layout: false});
  
  app.use(express.favicon())
  app.use(express.cookieParser());
  app.use(express.session({secret: settings.webserver.sessionKey}));
  app.use(function(req, res, next) {
    if (req.headers["x-authenticated-user"]) {
      req.auth = {user: req.headers["x-authenticated-user"]};
      // TODO: Lookup user details and cache them with a maxage
    }
    next();
  });
  
  // Force user to be logged-in for access
  app.use(function(req, res, next) {
    if (!req.auth) {
      res.writeHead(301, {'Location': '/login?login-required&referrer='+settings.baseurl+req.url}); // redirect
      res.end();
      return;
    }
    next();
  })
});

app.configure('development', function(){
  app.use(express.errorHandler({dumpExceptions: true, showStack: true}));
});

app.configure('production', function(){
  app.use(express.errorHandler());
});

///////////////////////////////////////////////////////////////

// Main pages
app.get("/", function(req, res) {
  res.render('mapper', {settings: settings, request: req});
});
app.get("/changelog", function(req, res) {
  res.render('changelog', {settings: settings, request: req});
});
app.get("/about", function(req, res) {
  res.render('about', {settings: settings, request: req});
});

///////////////////////////////////////////////////////////////

// return last snapshot
app.get("/snapshot/last", function(req, res) {
  get_snapshot(new Date(), function(item) {
    res.writeHeader(200, {"Content-type": "application/json"});
    res.end(JSON.stringify(item));
  });      
});  

// return snapshot json
app.get("/snapshot/:datetime", function(req, res) {
  var datetime = new Date(date.getDateFromFormat(req.params.datetime,"yyyyMMddHHmmss"));
  get_snapshot(datetime, function(result) {
    res.writeHeader(200, {"Content-type": "application/json"});
    res.end(JSON.stringify(result));
  })
});

// return json-diff between two snapshots
app.get("/diff/:from/:to?", function(req, res) {
  var from = new Date(date.getDateFromFormat(req.params.from,"yyyyMMddHHmmss"));
  var to = req.params.to ? new Date(date.getDateFromFormat(req.params.to,"yyyyMMddHHmmss")) : new Date();
   
  async.auto({
  
    config: function(cb) {
      fs.readFile(__dirname+'/public/compare-config.json', function(err, contents) {
        cb(null, JSON.parse(contents));
      });
    },
  
    from_query: function(cb) {        
      get_snapshot(from, function(item) {
        cb(null, item);
      });      
    },
    
    to_query: function(cb) {
      get_snapshot(to, function(item) {
        cb(null, item);
      });      
    },
    
    finalize: ['config', 'from_query', 'to_query', function(cb, result) {
      if (result.from_query && result.to_query) {
      
        var diff = jsoncomp.compare(result.from_query,result.to_query,result.config);
        
        res.writeHeader(200, {"Content-type": "application/json"});    
        res.end(JSON.stringify(diff));
      } else {          
        res.end();
      }
      cb();
    }]
    
  });
  
});
  
// -----------------------------------------------------------------

app.get("/vpc/info", function(req, res) {
  res.writeHeader(200, {"Content-type": "application/json"});
  var vpc_info = new mongo.Collection(ec2db, 'vpc_info');
  vpc_info.find({}).toArray(function(err, items) {
    var result = {};
    _.each(items, function(item) {
      delete item["_id"];
      result[item.id] = item; 
    });
    res.end(JSON.stringify(result));
  });    
});  

app.get("/vpc/info/setname/:id/:name", function(req, res) {
  res.writeHeader(200, {"Content-type": "application/json"});
  var vpc_info = new mongo.Collection(ec2db, 'vpc_info');
  vpc_info.insert({id: req.params.id}, {"$set":{name: req.params.name}}, true);
  res.end();
});  

app.get("/image/:id", function(req, res) {
  ec2.call("DescribeImages", {"ImageId": req.params.id}, function(result) {
    result = result && result.imagesSet && result.imagesSet.item ? result.imagesSet.item : {};
    res.writeHeader(200, {"Content-type": "application/json"});
    res.end(JSON.stringify(result));
  });
});  

app.get("/instance/info", function(req, res) {
  res.writeHeader(200, {"Content-type": "application/json"});
  var vpc_info = new mongo.Collection(ec2db, 'instance_info');
  vpc_info.find({}).toArray(function(err, items) {
    var result = {};
    _.each(items, function(item) {
      delete item["_id"];
      result[item.id] = item; 
    });
    res.end(JSON.stringify(result));
  });    
});  

app.get("/instance/info/setname/:id/:name", function(req, res) {
  res.writeHeader(200, {"Content-type": "application/json"});
  var inst_info = new mongo.Collection(ec2db, 'instance_info');
  inst_info.insert({id: req.params.id}, function() {
    inst_info.update({id: req.params.id}, {"$set":{name: req.params.name}}, true);
    res.end();
  })
});   
  

// Static files
app.use(express.static(__dirname + '/public', {redirect: ""}));
app.use(express.favicon())

app.listen(settings.webserver.port, settings.webserver.host);

// -----------------------------------------------------------------------------------

// Downgrade privileges to non-root account
if (process.getuid() === 0) {
  process.setuid('www-data');
}

console.log(settings.title+" listening on port %d in %s mode", settings.webserver.port, app.settings.env);


//////////////////////////////////////////////////////////////////////////////////////

// Get date snapshots for sec/dev/extranet and consumerfinance, merge them together
function get_snapshot(datetime, cb) {
  var snapshots = new mongo.Collection(ec2db, 'snapshots');
  snapshots.find({'type':'amazon', 'datetime': {"$lte": datetime}}, {}).sort({datetime:-1}).limit(1).toArray(function(err, items) {
    if (items.length > 0) {
      var item = items[0];
      
      // Merge in consumerfinanance results
      snapshots.find({'type':'amazon-consfin', 'datetime': {"$lte": datetime}}, {}).sort({datetime:-1}).limit(1).toArray(function(err, items) {
      
        var res_item = {};
      
        if (items.length > 0) {
          var cf_item = items[0];
          
          _.each(_.uniq(_.union(_.keys(item), _.keys(cf_item))), function(key) {
            if (!_.has(item, key)) {
              item[key] = {};
            }
            res_item[key] = _.extend(item[key], cf_item[key]);
          });
          
          delete res_item["_id"];
          
          // output final results
          cb(res_item);
        } else {
          cb(item);
        }
      });      
    } else {
      cb(JSON.stringify({}));
    }
  });    
}

