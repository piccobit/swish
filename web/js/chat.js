/*  Part of SWISH

    Author:        Jan Wielemaker
    E-mail:        J.Wielemaker@cs.vu.nl
    WWW:           http://www.swi-prolog.org
    Copyright (C): 2016-2017, VU University Amsterdam
			      CWI Amsterdam
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

    1. Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
       notice, this list of conditions and the following disclaimer in
       the documentation and/or other materials provided with the
       distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
    FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
    COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
    INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
    BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
    LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
    CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
    LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
    ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.
*/

/**
 * @fileOverview
 * Deal with cooperation
 *
 * @version 0.2.0
 * @author Jan Wielemaker, J.Wielemaker@vu.nl
 * @requires jquery
 */

define([ "jquery", "config", "preferences", "form", "utils" ],
       function($, config, preferences, form, utils) {

(function($) {
  var pluginName = 'chat';

  /** @lends $.fn.chat */
  var methods = {
    _init: function(options) {
      return this.each(function() {
	var elem = $(this);
	var data = {};			/* private data */

	elem.data(pluginName, data);	/* store with element */

	/* add event handling */
	elem.on("click", function(ev) {
	  var li = $(ev.target).closest("li.user");

	  if ( li.length == 1 )
	    elem.chat('unnotify', li.attr("id"));
	});
	elem.on("send", function(ev, msg) {
	  elem.chat('send', msg);
	});
	$(window).bind("beforeunload", function() {
	  elem.chat('disconnect');
	});

	/* setup websocket */
	if ( config.swish.chat ) {
	  elem.chat('connect');
	}
      });
    },

		 /*******************************
		 *	      WEBSOCKET		*
		 *******************************/

    /**
     * Create a websocket connection to /chat on the SWISH server.
     */
    connect: function() {
      var elem = this;
      var data = this.data(pluginName);
      var url  = window.location.host + config.http.locations.swish_chat;
      var lead = "?";

      function add_pref_param(name, pname) {
	var value = preferences.getVal(pname);

	if ( value ) {
	  url += lead + name + "=" + encodeURIComponent(value);
	  lead = "&";
	}
      }

      add_pref_param("avatar",   "anon-avatar");
      add_pref_param("nickname", "nick-name");

      if ( data.reconnect ) {			/* reconnecting */
	url += lead + "reconnect" + "=" + encodeURIComponent(data.reconnect);
	lead = "&";
      }

      data.connection = new WebSocket("ws://" + url, ['chat']);

      data.connection.onerror = function(error) {
      };
      data.connection.onclose = function(ev) {
	elem.chat('connect');
      };
      data.connection.onmessage = function(e) {
	var msg = JSON.parse(e.data);
	msg.origin = e.origin;
	if ( msg.type )
	  elem.chat(msg.type, msg);
	else
	  console.log(e);
      };
      data.connection.onopen = function() {
	elem.chat('empty_queue');
	$(".storage").storage('chat_status');
      };
    },

    empty_queue: function() {
      var data = this.data(pluginName);

      while(data.queue && data.queue != [] && data.connection.readyState == 1) {
	var str = shift(data.queue);
	data.connection.send(str);
      }
    },

    disconnect: function() {
      var data = this.data(pluginName);

      this.chat('send', {type: "unload"});
      data.connection.onclose = function(){};
      data.connection.close();
      data.connection = undefined;

      return this;
    },


		 /*******************************
		 *	   BASIC MESSAGES	*
		 *******************************/

    /**
     * @param {Object} msg is the JSON object to broadcast
     */
    send: function(msg) {
      var data = $(this).data(pluginName);

      if ( data && data.connection ) {
	var str = JSON.stringify(msg);

	if ( data.connection.readyState != 1 ) {
	  if ( !data.queue )
	    data.queue = [str];
	  else
	    data.queue.push(str);
	  methods.connect();
	} else {
	  data.connection.send(str);
	}
      }

      return this;
    },

    subscribe: function(channel, sub_channel) {
      var msg = { type: "subscribe", channel: channel };

      if ( sub_channel )
	msg.sub_channel = sub_channel;

      this.chat('send', msg);
    },

    unsubscribe: function(channel, subchannel) {
      var msg = { type: "unsubscribe", channel: channel };

      if ( sub_channel )
	msg.sub_channel = sub_channel;

      this.chat('send', msg);
    },

		 /*******************************
		 *	      ACTIONS		*
		 *******************************/

    /**
     * The welcome message is sent by SWISH immediately after opening
     * the websocket connection.  It provides the session UID for this
     * user
     */
    welcome: function(e) {
      var data = $(this).data(pluginName);

      if ( data.wsid && data.wsid != e.wsid ) {
	this.html("");				/* server restart? */
      }

      data.wsid = e.wsid;
      data.reconnect = e.reconnect;		/* reconnection token */
      if ( e.avatar && e.avatar_generated )
	preferences.setVal("anon-avatar", e.avatar);
      e.role = "self";

      var li = this.chat('addUser', e);
      $(li).addClass("myself");
      this.chat('userCount', e.visitors);
    },

    userCount: function(cnt) {
      $("#user-count").text(cnt);
    },

    /**
     * Replied when opening SWISH on a file to inform
     * the new user about existing visitors to same
     * files as are open in the current SWISH.  See
     * inform_newby_about_existing_gazers/2.
     */
    gazers: function(e) {
      if ( e.gazers ) {
	for(var i=0; i<e.gazers.length; i++) {
	  var gazer = e.gazers[i];
	  this.chat('addUser', gazer);
	  if ( gazer.file )
	    this.chat('addUserFile', gazer.wsid, gazer.file);
	}
      }
    },

    /**
     * Replied if the profile associated with a visitor changes.  A
     * key `reason` carries the reason for the change.
     */

    profile: function(e) {
      var li = $("#"+e.wsid);

      li.children("a").html("").append(avatar(e));
      if ( e.avatar )
	$("*[data-userid="+e.wsid+"] img.avatar").attr("src", e.avatar);

      if ( e.name ) {
	li.prop('title', e.name);
	if ( e.reason == 'set-nick-name' ) {
	  e.html = "Named <i>"+utils.htmlEncode(e.name)+"</i>";
	  this.chat('notifyUser', e);
	}
      }
    },

    /**
     * A user has rejoined. This is the case if we lost the
     * connection and the connection was re-established.
     */
    rejoined: function(e) {
      var avatars = $("#"+e.wsid);

      this.chat('lost', avatars, false);
      if ( e.visitors )
	this.chat('userCount', e.visitors);
    },

    /**
     * A new user has joined.
     */
    joined: function(e) {
      if ( e.visitors )
	this.chat('userCount', e.visitors);
    },

    /**
     * Display a notification by some user.
     */
    notify: function(e) {
      this.chat('notifyUser', e);
    },

    /**
     * Add incomming chat messages to the chatroom.  If there is no
     * chatroom we should warn/open it
     */
    'chat-message': function(e) {
      var room = $("div.chatroom");

      if ( room.length > 0 ) {
	room.chatroom('add', e);
      } else {
	if ( $("#"+e.user.id).length > 0 ) {
	  msg = $.extend({}, e);
	  msg.wsid = e.user.id;
	  msg.html = "Wants to chat";
	  this.chat('notifyUser', msg);
	  this.chat('queue_chat_message', e);
	}
      }
    },

    queue_chat_message: function(msg) {
      var data = this.data(pluginName);

      if ( !data.chat_messages )
	data.chat_messages = [];
      data.chat_messages.push(msg);
      return this;
    },

    queued_chat_messages: function(truncate) {
      var data = this.data(pluginName);
      var queue = data.chat_messages||[];

      if ( truncate )
	data.chat_messages = [];

      return queue;
    },


		 /*******************************
		 *	        UI		*
		 *******************************/

    /**
     * Present a notification associated with a user
     *
     * @param {Object} options
     * @param {String} options.html provides the inner html of the message.
     * @param {Number} [options.fadeIn=400] provide the fade in time.
     * @param {Number} [options.fadeOut=400] provide the fade out time.
     * @param {Number} [options.time=5000] provide the show time.  The
     * value `0` prevents a timeout.
     */
    notifyUser: function(options) {
      var elem = this;
      var user_li = this.chat('addUser', options);

      if ( user_li.length > 0 ) {
	var div  = $.el.div({ class:"notification notify-arrow",
			      id:"ntf-"+options.wsid
			    });
	var epos = user_li.offset();

	$("body").append(div);
	$(div).html(options.html)
	      .css({ left: epos.left+user_li.width()-$(div).outerWidth()+15,
		     top:  epos.top+user_li.height()+12
		   })
	      .on("click", function(){$(div).remove();})
	      .show(options.fadeIn||400);

	if ( options.time !== 0 ) {
	  var time = options.time;

	  if ( !time )
	    time = user_li.hasClass("myself") ? 1000 : 5000;

	  setTimeout(function() {
	    $(div).hide(options.fadeOut||400, function() {
	      elem.chat('unnotify', options.wsid);
	    });
	  }, time);
	}

	this.chat('updateFiles', options);
      }
    },

    unnotify: function(wsid) {
      $("#ntf-"+wsid).remove();

      if ( $("#"+wsid).hasClass("removed") )
	this.chat('removeUser', wsid);

      return this;
    },

    updateFiles: function(options) {
      var data = $(this).data(pluginName);

      function file() {
	return options.event_argv[0];
      }

      if ( options.event == "opened" ) {
	this.chat('addUserFile', options.wsid, file());
      } else if ( options.event == "closed" ) {
	var wsid = options.wsid == data.wsid ? undefined : options.wsid;
	this.chat('removeUserFile', wsid, file(), true);
      }
    },

    /**
     * Return or add a user to the notification area.
     * @param {Object} options
     * @param {String} options.wsid Identifier for the user (a UUID)
     * @param {String} [options.name] is the name of the user
     * @returns {jQuery} the `li` element representing the user
     */
    addUser: function(options) {
      var li = $("#"+options.wsid);

      if ( li.length == 0 )
      { li = $(li_user(options.wsid, options));
	this.prepend(li);
      } else {
	this.chat('lost', li, false);
      }

      return li;
    },

    /**
     * Remove a user avatar.  If a notification is pending we delay
     * removal until the notification times out
     */
    removeUser: function(wsid) {
      if ( typeof wsid == "string" ) {
	wsid = {wsid:wsid};
      }

      if ( wsid.visitors !== undefined )
	this.chat('userCount', wsid.visitors);
      var li = $("#"+wsid.wsid);
      if ( li.length == 0 )
	return this;

      if ( wsid.reason != "close" ) {
	if ( $("#ntf-"+wsid.wsid).length > 0 )	/* notification pending */
	  li.addClass("removed");
	else
	  li.hide(400, function() {this.remove();});
      } else {					/* connection was lost */
	this.chat('lost', li, true);
      }

      return this;
    },

    /**
     * Set/clear lost-connection state of users.
     * @param {jQuery} li set of items to set/clear
     * @param {Boolean} lost is `true` if we lost the connection
     */
    lost: function(li, lost) {
      if ( lost ) {
	li.addClass("lost");
      } else {
	li.removeClass("lost");
      }

      li.each(function() {
	var elem = $(this);
	if ( lost ) {
	  elem.data('lost-timer',
		    setTimeout(function() {
		      if ( $("#"+wsid.wsid).hasClass("lost") )
			$("#"+wsid.wsid).remove();
		    }, 60000));
	} else {
	  var tmo = elem.data('lost-timer');
	  if ( tmo ) {
	    clearTimeout(tmo);
	    elem.data('lost-timer', undefined);
	  }
	}
      });
    },

    /**
     * Get the set of visible users.  The return is an object holding
     * a key `self` and a key `users` bound to an array of users.
     * `self` points to the user of this browser.  Self always has
     * all keys
     * @param {Array} [fields] lists the keys we want to have in the
     * user objects.  Default is all we have.
     */
    users: function(fields) {
      var users = [];
      var rc = {users:users};

      this.find("li.user[id]").each(function() {
	var elem = $(this);
	var user = {};
	var self = elem.hasClass("myself");

	if ( self || !fields || fields.indexOf('id') >= 0 )
	  user.id = elem.attr("id");
	if ( self || !fields || fields.indexOf('name') >= 0 )
	  user.name = elem.prop("title");
	if ( self || !fields || fields.indexOf('avatar') >= 0 )
	  user.avatar = elem.find("img.avatar").attr("src");

	if ( self ) {
	  rc.self = $.extend({}, user);
	  user.is_self = true;
	}

	users.push(user);
      });

      return rc;
    },

    self: function() {
      return this.find("li.user.myself[id]").attr("id");
    },

    start_chat: function() {
      var chat = $(".chatroom");

      if ( chat.length > 0 ) {
	utils.flash(chat);
      } else {
	var users = this.chat('users', ['id']);

	if ( users.users.length <= 1 ) {
	  $(".swish-event-receiver").trigger("help", {file:"chat.html"});
	}

	$("body").swish('start_chat');
      }

      return this;
    },

    /**
     * Browser `wsid` has opened `file`
     */
    addUserFile: function(wsid, file) {
      var li = $("#"+wsid);
      var ul = li.find("ul.dropdown-menu");
      var fli;

      ul.find("li.file").each(function() {
	if ( $(this).data("file") == file ) {
	  fli = this;
	  return false;
	}
      });

      if ( fli == undefined ) {
	var type = file.split(".").pop();
	ul.append(
	  $.el.li({class:"file", "data-file":file, title:"Shared file"},
		  $.el.a($.el.span({class: "dropdown-icon type-icon "+type}),
			 file)));
      }

      return this;
    },

    /**
     * Remove a file associated with the user wsid.
     * @param {String} [wsid] User for which to remove file.  If
     * `undefined`, remove file for all users.
     * @param {Boolean} [user_too] if `true', remove the user if
     * the set of files becomes empty and this is not `myself`.
     */
    removeUserFile: function(wsid, file, user_too) {
      var elem = this;

      function removeFile(user_li) {
	var ul = user_li.children("ul.dropdown-menu");

	ul.find("li.file").each(function() {
	  if ( $(this).data("file") == file ) {
	    $(this).remove();
	    if ( user_too &&
		 !user_li.hasClass("myself") &&
		 ul.find("li.file").length == 0 )
	      elem.chat('removeUser', user_li.attr("id"));
	    return false;
	  }
	});
      }

      if ( wsid ) {
	removeFile($("#"+wsid));
      } else {
	this.children().each(function() {
	  removeFile($(this), file, user_too);
	});
      }
    }
  }; // methods

  // Private functions

  /**
   * Add an entry for a user to the notification area
   */
  function li_user(id, options) {
    options = options||{};
    var ul;
    var a;
    var name = options.name;

    if ( !name && options.role == "self" )
      name = "Me";
    if ( !name )
      name = id;

    var li = $.el.li({class:"dropdown user", id:id, title:name},
		   a=$.el.a({ class:"dropdown-toggle avatar",
			      'data-toggle':"dropdown"
			    },
			    avatar(options)),
		  ul=$.el.ul({ class:"dropdown-menu pull-right",
			       title:""
			     }));

    if ( options.role == "self" ) {
      $(a).append($.el.b({class:"caret"}));

      var input = $.el.input({ type:"text",
			       placeholder:"Nick name",
			       value:options.name||"",
			       title:"Nick name"
			     });
      ul.append($.el.li(input));
      $(input).keypress(function(ev) {
	if ( ev.which == 13 ) {
	  var name = $(input).val().trim();

	  if ( name != "" ) {
	    $("#chat").trigger('send',
			       { type:'set-nick-name',
				 name: name
			       });
	    preferences.setVal("nick-name", name);
	  }
	  $(input).closest('.dropdown.open').removeClass('open');
	}
      });

      form.widgets.populateMenu($(li), $("#chat"), {
	"Chat ...": function() {
	  this.chat('start_chat');
	},
      });

      ul.append($.el.li({class:"divider"}));
    }

    return li;
  }

  function avatar(options) {
    if ( options.avatar ) {
      return $.el.img({ class:"avatar", src:options.avatar
		      });
    } else {
      return $.el.span({class:"avatar glyphicon glyphicon-user"})
    }
  }


  /**
   * <Class description>
   *
   * @class chat
   * @tutorial jquery-doc
   * @memberOf $.fn
   * @param {String|Object} [method] Either a method name or the jQuery
   * plugin initialization object.
   * @param [...] Zero or more arguments passed to the jQuery `method`
   */

  $.fn.chat = function(method) {
    if ( methods[method] ) {
      return methods[method]
	.apply(this, Array.prototype.slice.call(arguments, 1));
    } else if ( typeof method === 'object' || !method ) {
      return methods._init.apply(this, arguments);
    } else {
      $.error('Method ' + method + ' does not exist on jQuery.' + pluginName);
    }
  };
}(jQuery));
});
