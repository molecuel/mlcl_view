var path    = require('path');
var walk    = require('walk');
var handlebars = require('handlebars');
var _       = require('underscore');
var fs      = require('fs');
var async   = require('async');
var debug = require('debug')('mlcl_view');
var molecuel;

var helpers = require('./lib/helpers');

var VIEWS_DIR = 'views';
var THEME_DIR = 'theme';
var TEMPLATES = 'templates';
var PARTIALS  = 'partials';
var LAYOUTS   = 'layouts';
var MODULES   = 'modules';

/**
 * Regex pattern for layout directive. {{!< layout }}
 */
var layoutPattern = /{{!<\s+([A-Za-z0-9\._\-\/]+)\s*}}/;

/**
 * View module as theming layer for molecuel CMS
 */
var view = function() {
  var self = this;
  this.helpers = { global: {}, request: {} };
  this.themes = {};
  this.cache = {};

  molecuel.on('mlcl::core::init:post', function() {
    self.init();

    // load default helpers
    helpers.registerViewHelpers(self);

    // themes must listen to this event to register themselves
    molecuel.emit('mlcl::view::register:theme', self);

    // modules must provide listener
    molecuel.emit('mlcl::view::register:helper', self);
  });
};

view.prototype.init = function init() {

};

view.prototype.registerHelper = function(name, helper) {
  this.helpers.global[name] = helper;
};

view.prototype.registerRequestHelper = function(name, func) {
  this.helpers.request[name] = func;
};


/**
 * registerTheme - description
 *
 * @param  {type} theme description
 * @return {type}       description
 */
view.prototype.registerTheme = function registerTheme(theme, callback) {
  var self = this;
  var err;
  var name = theme.name;
  if(!name) {
    err = "No name for theme given";
  }
  if(!theme.dir) {
    err = "No directory for theme given";
  }
  if(err) {
    return callback(err);
  }
  this.themes[name] = theme;

  // load all files
  self.registerDirectory(theme.dir, function(err, paths) {

    if(paths.partials) {
      _.each(paths.partials, function(filePath, name) {
        paths.partials[name] = fs.readFileSync(filePath, 'utf8');
      });
    }
    theme.files = paths;
    return callback();
  });
};

view.prototype.registerDirectory = function(rootPath, callback) {
  var paths = { };
  paths[LAYOUTS] = {};
  paths[TEMPLATES] = {};
  paths[PARTIALS] = {};

  walk.walk(rootPath).on('file', function(root, stat, next) {

    var isValidTemplate = /\.(html|hbs|json)$/.test(stat.name);
    if(!isValidTemplate) {
      return next();
    }

    var module = null;
    var rel = path.relative(rootPath, root);
    var els = rel.split(path.sep);
    var f = els.shift();

    if(f === MODULES) {
      module = els.shift();
      f = els.shift();
    }
    var ext = path.extname(stat.name);
    var basename = stat.name.slice(0, -ext.length);
    var filename = els.length ? els.join('/') + '/' + basename : basename;

    if(module) {
      if(!paths.modules) paths.modules = {};
      if(!paths.modules[module]) paths.modules[module] = {};
      if(!paths.modules[module][f]) paths.modules[module][f] = {};
      paths.modules[module][f][filename] = path.join(root, stat.name);
    } else if(paths[f]) {
      paths[f][filename] = path.join(root, stat.name);
    }
    next();

  }).on('end', function() {
    callback(null, paths);
  });
};


view.prototype.get = function get(req, res, next) {
  var self = this;
  var content = res.locals;

  if(!content) {
    return next();
  }
  // create theme instance clone
  var theme = self.getTheme(content);

  // initialize separate handlebars instance for each request
  var hbs = handlebars.create();

  // register partials
  _.each(theme.files.partials, function(partial, name) {
    hbs.registerPartial(name, partial);
  });

  // register helpers
  _.each(self.helpers.global, function(helper, name) {
    hbs.registerHelper(name, helper);
  });
  _.each(self.helpers.request, function(helper, name) {
    hbs.registerHelper(name, helper.apply(self, [self, req, res]));
  });

  theme.hbs = hbs;
  res.locals._view.theme = theme;

  var html = '';
  var regions;

  theme.prepareContent(req, res, function(err) {
    if(err) {
      return res.send(500, err);
    }

    async.series([
      function renderContents(cb) {
        self.renderRegions(req, res, function(err, result) {
          regions = result;
          cb();
        });
      },
      function renderLayout(cb) {
        var layout = res.locals._view.layout;
        var layout = self.getLayout(theme, layout);
        var data = regions;
        self.renderFile(req, res, data, layout, function(err, result) {
          if(err) {
            return cb(err);
          }
          html = result;
          cb();
        });
      }
    ], function(err) {
      if(err) {
        return res.send(500, err);
      }
      return res.send(html);
    });
  });
};

/**
 *
 * @param locals
 * @returns {*}
 */
view.prototype.getTheme = function(locals, options) {
  var self = this;
  var options = options || {};
  if(!locals._view) {
    locals._view = { theme: 'default' };
  }
  var name = locals._view.theme;
  if(!self.themes[name]) {
    name = Object.keys(self.themes).shift();
  }
  if(self.themes[name]) return _.clone(self.themes[name]);
  return;
};

/**
 * Resolves the correct template based on module/suggestion information
 *
 * @param module
 * @param suggestions
 * @returns {*}
 */
view.prototype.getLayout = function(theme, suggestions) {
  var self = this;
  var t;
  if(_.isString(suggestions)) suggestions = Array(suggestions);
  if(_.isArray(suggestions)) {
    _.each(suggestions, function(path, index) {
      if(theme.files.layouts[path]) {
        t = theme.files.layouts[path];
        return;
      }
    });
  }
  console.log("LAYOUT IS: "  + t);
  return t;
};


/* ************************************************************************
 RENDERING
 ************************************************************************ */
view.prototype.renderRegions = function(req, res, callback) {
  var self = this;
  var data = res.locals.data || {};
  var result = {};

  async.each(Object.keys(data), function(name, cb) {
    var object = data[name];
    self.render(req, res, object, function(err, html) {
      if(err) {
        return cb(err);
      }
      result[name] = html;
      cb();
    });
  }, function(err) {
    if(err) {
      return callback(err);
    }
    return callback(null, result);
  });
};

view.prototype.render = function(req, res, context, callback) {
  var self = this;

  if(_.isArray(context)) {
    var result = [];
    async.each(context, function(item, cb) {
      self.renderObject(req, res, item, function(err, html) {
        if(err) {
          cb(err);
        } else {
          if(html) {
            result.push(html);
          }
        }
        cb();
      });
    }, function(err) {
      if(err) {
        return callback(err);
      }
      callback(null, result.join('<br/>'));
    });
  } else {
    self.renderObject(req, res, context, function(err, html) {
      if(err) {
        callback(err);
      } else {
        callback(null, html);
      }
    });
  }
};

view.prototype.renderObject = function(req, res, item, callback) {
  var self = this;
  var err;
  var module, type, template;
  item._meta = item._meta || {};
  if(!item._meta) {
    err = new Error("No META-Information found on Object");
    callback(err);
  }
  if(item._meta.module) {
    module = item._meta.module;
  }
  template = self.getTemplate(req, res, item);
  // still no template
  if(!template) {
  }

  if(template) {
    self.renderFile(req, res, item, template, function(err, html) {
      if(err) {
        return callback(err);
      }
      callback(null, html);
    });
  } else {
    callback(null, 'no template found for item');
  }
};

/**
 * Resolves the correct template based on module/suggestion information
 *
 * @param module
 * @param suggestions
 * @returns {*}
 */
view.prototype.getTemplate = function(req, res, item, suggestions) {
  var self = this;
  var module;
  var type;
  var suggestions = suggestions || [];
  var theme = res.locals._view.theme;
  if(!_.isArray(suggestions)) {
    suggestions = Array(suggestions);
  }
  if(!item._meta) {
    return;
  }
  if(item._meta) {
    module = item._meta.module;
    type = item._meta.type;
    if(type) suggestions.push(type);
  }

  if(item._view) {
    if(item._view.template) {
      if(_.isArray(item._view.template)) {
        //suggestions = suggestions.concat(item._view.template);
      } else {
        suggestions.push(item._view.template);
      }
    }
  }

  var t;
  _.each(suggestions.reverse(), function(path, index) {
    if(module) {
      path = Array(module, path).join('/');
    }
    if(!t && theme.files && theme.files.templates && theme.files.templates[path]) {
      t = theme.files.templates[path];
    }
  });
  return t;
};

/**
 * Renders `file` with given `data` and
 *
 * @param res
 * @param data
 * @param filename
 * @param cb
 * @returns {*}
 */
view.prototype.renderFile = function(req, res, data, filename, cb) {
  var self = this;
  var locals = res.locals;
  var theme = locals._view.theme;
  var compiled = self.compileFile(req, res, filename);
  if(compiled) {
    template = compiled.template;
    try {
      //set variables
      var vars = _.clone(data);
      vars.locals = locals;
      vars.locals.req = _.clone(req);
      console.log("TEMPLATE RENDER: " + filename);
      html = template( vars, {helpers: res.locals._view.theme.helpers, data: {req:req.locals, res:res.locals}});
    } catch (err) {
      console.log(err);
      if (err.message) {
        err.message = '[' + template.__filename + '] ' + err.message;
      } else if (typeof err === 'string') {
        err = '[' + template.__filename + '] ' + err;
      }
      return cb(err, null);
    }

    if(compiled.layout) {
      self.renderFile(req, res, {body: html, locals: locals}, compiled.layout, cb);
    } else {
      cb(null, html);
    }
  } else {
    cb('[' + filename + '] not resolvable');
  }
}

view.prototype.compileFile = function(req, res, filename) {
  var self = this, template;
  var theme = res.locals._view.theme;
  var cache = self.cache[filename];
  if(!cache) {
    if(filename) {
      var source = fs.readFileSync(filename, 'utf8');
      template = theme.hbs.compile(source);
      var layout;
      var matches = source.match(layoutPattern);
      if(matches) {
        layout = self.getLayout(theme, matches[1]);
      }
      cache = {
        source: source,
        template: template,
        layout: layout
      }
      theme.cache = theme.cache || {};
      theme.cache[filename] = cache;
    }
  }
  return cache;
};

view.prototype.partial = function(locals, name, context) {
  var self = this;
  var theme = locals._view.theme;
  if(theme.hbs.partials[name]) {
    var partial = theme.hbs.partials[name];
    if(partial) {
      var c = theme.hbs.compile(partial);
      return new theme.hbs.SafeString(c(context));
    }
  }
}

/* ************************************************************************
 SINGLETON CLASS DEFINITION
 ************************************************************************ */
var instance = null;

/**
 * Singleton getInstance definition
 * @return singleton class
 */
var getInstance = function () {
  if (instance === null) {
    instance = new view();
  }
  return instance;
};


var init = function(mlcl) {
  molecuel = mlcl;
  return getInstance();
};

module.exports = init;
