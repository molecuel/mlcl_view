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

  // load all template files
  self.registerDirectory(theme.dir, function(err, paths) {

    // initialize handlebars instance
    var hbs = handlebars.create();

    // load the partials
    if(paths.partials) {
      _.each(paths.partials, function(filePath, name) {
        paths.partials[name] = fs.readFileSync(filePath, 'utf8');
      });
    }
    theme.files = paths;

    // register partials
    _.each(theme.files.partials, function(partial, name) {
      hbs.registerPartial(name, partial);
    });

    // register helpers
    _.each(self.helpers.global, function(helper, name) {
      hbs.registerHelper(name, helper);
    });

    theme.hbs = hbs;

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

  res.locals._view.theme = theme;
  res.locals._html = { blocks: {}, container: {}};
  var html = '';
  var regions;

  theme.prepareContent(req, res, function(err) {
    if(err) {
      return res.send(500, err);
    }
    if(req.query.json || req.query.debug) {
      return res.send(res.locals.data);
    }

    async.series([
      function initRequestHelper(cb) {
        self.initRequestHelper(req, res, function(err, helpers) {
          if(err) {
            return cb(err);
          }
          res.locals._view.helpers = helpers;
          cb();
        });
      },
      function renderBlocks(cb) {
        self.renderBlocks(req, res, function(err, result) {
          cb();
        });
      },
      function renderContents(cb) {
        self.renderRegions(req, res, function(err, result) {
          regions = result;
          cb();
        });
      },
      function renderLayout(cb) {
        var layout = res.locals._view.layout || 'default';
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

view.prototype.initRequestHelper = function(req, res, callback) {
  var self = this;
  var helpers = {};
  async.each(Object.keys(self.helpers.request), function(name, cb) {
    helpers[name] = self.helpers.request[name].apply(self, [self, req, res]);
    cb();
  }, function(err) {
    if(err) {
      return callback(err);
    }
    return callback(null, helpers);
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
  if(self.themes[name]) return self.themes[name];
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
view.prototype.renderBlocks = function(req, res, callback) {
  var self = this;
  var blocks = res.locals.blocks || {};
  var container = res.locals._html.container;
  var result = {};

  // block target
  var targets = [];

  async.each(blocks, function(block, cb) {
    self.renderBlock(req, res, block, function(err, html) {
      if(block.target && _.indexOf(targets, block.target) == -1) {
        targets.push(block.target);
      }
      cb();
    });
  }, function(err) {
    if(err) {
      return callback(err);
    }
    _.each(targets, function(target) {
      var target_blocks = _.sortBy(_.filter(blocks, function(block) { return block.target == target; }), function(block) { return Number(block.sequence); });
      var html = '';
      _.each(target_blocks, function(block) {
        html += block._html;
      });
      container[target] = html;
    });
    return callback(null, result);
  });
};

view.prototype.renderBlock = function renderBlock(req, res, block, callback) {
  var self = this;
  var item = _.clone(block.data);
  item._view = _.clone(block._view);
  item._meta = _.clone(block._meta);

  self.render(req, res, item, function(err, html) {
    if(err) {
      return cb(err);
    }
    block._html = html;
    callback(null, html);
  });
};

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
  if(item._view) {
    if(item._view.template) {
      console.log(item._view);
      if(_.isArray(item._view.template)) {
        suggestions = suggestions.concat(item._view.template);
      } else {
        suggestions.push(item._view.template);
      }
    }
  }

  var t;
  _.each(suggestions, function(path, index) {
    debug("validate template path: " + path);
    if(!t && theme.files && theme.files.templates && theme.files.templates[path]) {
      debug("use template path: " + path);
      t = theme.files.templates[path];
    }
  });
  debug("resolved: " + t);
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
view.prototype.renderFile = function(req, res, data, filename, callback) {
  var self = this;
  var locals = res.locals;
  var theme = locals._view.theme;
  var compiled = self.compileFile(req, res, filename);
  debug('Render file ' + filename);
  if(compiled) {
    template = compiled.template;
    try {
      //set variables
      var vars = _.clone(data);
      vars.locals = locals;
      vars.locals.req = _.clone(req);
      html = template( vars, {helpers: res.locals._view.helpers, data: {req:req.locals, res:res.locals, container:res.locals._html.container }});
    } catch (err) {
      console.log(err);
      if (err.message) {
        err.message = '[' + template.__filename + '] ' + err.message;
      } else if (typeof err === 'string') {
        err = '[' + template.__filename + '] ' + err;
      }
      return callback(err, null);
    }

    if(compiled.layout) {
      self.renderFile(req, res, {body: html, locals: locals}, compiled.layout, callback);
    } else {
      callback(null, html);
    }
  } else {
    callback('[' + filename + '] not resolvable');
  }
};

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
